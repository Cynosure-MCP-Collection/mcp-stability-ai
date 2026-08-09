#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// ── Config ─────────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.stability.ai';
const DEFAULT_OUTPUT_DIR = path.join(tmpdir(), 'cynosure-mcp', 'stability-ai');

function getApiKey(): string {
    const key = process.env.STABILITY_API_KEY;
    if (!key) throw new Error('STABILITY_API_KEY environment variable is required');
    return key;
}

function getOutputDir(): string {
    return process.env.STABILITY_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ensureOutputDir(): string {
    const dir = getOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function generateFilename(prefix: string, format: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `${prefix}_${ts}.${format}`;
}

async function saveImage(data: Buffer, prefix: string, format: string): Promise<string> {
    const dir = ensureOutputDir();
    const filename = generateFilename(prefix, format);
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, data);
    return filepath;
}

interface StabilityError {
    id: string;
    name: string;
    errors: string[];
}

async function stabilityPost(
    endpoint: string,
    formData: FormData,
    accept: 'image/*' | 'application/json' = 'image/*'
): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${getApiKey()}`,
            accept,
            'stability-client-id': 'cynosure',
        },
        body: formData,
    });

    if (res.status === 200) {
        const arrayBuffer = await res.arrayBuffer();
        return { ok: true, data: Buffer.from(arrayBuffer) };
    }

    let errorMsg: string;
    try {
        const errBody = (await res.json()) as StabilityError;
        errorMsg = `Stability API error ${res.status}: ${errBody.errors?.join(', ') || errBody.name}`;
    } catch {
        errorMsg = `Stability API error ${res.status}: ${await res.text()}`;
    }
    return { ok: false, error: errorMsg };
}

function appendFileToForm(form: FormData, fieldName: string, filePath: string): void {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    const buffer = fs.readFileSync(absPath);
    const ext = path.extname(absPath).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
    const mime = mimeMap[ext] || 'application/octet-stream';
    form.append(fieldName, new Blob([buffer], { type: mime }), path.basename(absPath));
}

// ── Shared schemas ─────────────────────────────────────────────────────────────

const outputFormatSchema = z.enum(['png', 'jpeg', 'webp']).default('png').describe('Output image format');
const aspectRatioSchema = z.enum(['16:9', '1:1', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21']).default('1:1').describe('Aspect ratio of the generated image');
const stylePresetSchema = z.enum([
    '3d-model', 'analog-film', 'anime', 'cinematic', 'comic-book', 'digital-art',
    'enhance', 'fantasy-art', 'isometric', 'line-art', 'low-poly', 'modeling-compound',
    'neon-punk', 'origami', 'photographic', 'pixel-art', 'tile-texture'
]).optional().describe('Style preset to guide the image model');

// ── Server ─────────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Stability AI',
    version: '1.0.0',
    title: 'Stability AI',
    description: 'AI image generation, editing, and upscaling via the Stability AI API.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-stability-ai/icon.png', mimeType: 'image/png' }],
});

// ── Tool: generate_image ───────────────────────────────────────────────────────

server.registerTool(
    'generate_image',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Generate an image from a text prompt using Stability AI. Models: ultra (8 credits, best quality), core (3 credits, fast), sd3.5-large (6.5 credits), sd3.5-large-turbo (4 credits), sd3.5-medium (3.5 credits).',
        inputSchema: {
            prompt: z.string().min(1).max(10000).describe('Text description of the desired image'),
            model: z.enum(['ultra', 'core', 'sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium']).default('core').describe('Generation model to use'),
            aspect_ratio: aspectRatioSchema,
            negative_prompt: z.string().max(10000).optional().describe('What you do NOT want to see in the image'),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional().describe('Seed for reproducibility (0 = random)'),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('output_format', params.output_format);
        form.append('aspect_ratio', params.aspect_ratio);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        let endpoint: string;
        if (params.model === 'ultra') {
            endpoint = '/v2beta/stable-image/generate/ultra';
        } else if (params.model === 'core') {
            endpoint = '/v2beta/stable-image/generate/core';
        } else {
            endpoint = '/v2beta/stable-image/generate/sd3';
            form.append('model', params.model);
        }

        const result = await stabilityPost(endpoint, form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'generated', params.output_format);
        return {
            content: [
                { type: 'text', text: `Image generated and saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: image_to_image ───────────────────────────────────────────────────────

server.registerTool(
    'image_to_image',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Generate a new image from a text prompt using an existing image as the starting point. Uses SD 3.5 models.',
        inputSchema: {
            prompt: z.string().min(1).max(10000).describe('Text description of the desired output'),
            image_path: z.string().describe('Path to the input image file (jpeg, png, webp)'),
            strength: z.number().min(0).max(1).default(0.7).describe('How much influence the input image has (0 = identical, 1 = ignore input)'),
            model: z.enum(['sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium']).default('sd3.5-large').describe('SD 3.5 model variant'),
            negative_prompt: z.string().max(10000).optional().describe('What you do NOT want to see'),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('mode', 'image-to-image');
        form.append('model', params.model);
        form.append('strength', String(params.strength));
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/generate/sd3', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'img2img', params.output_format);
        return {
            content: [
                { type: 'text', text: `Image-to-image result saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: inpaint ──────────────────────────────────────────────────────────────

server.registerTool(
    'inpaint',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Fill in or replace specified areas of an image using a mask. White mask pixels = areas to replace, black = preserve. 5 credits.',
        inputSchema: {
            prompt: z.string().min(1).max(10000).describe('What you want to see in the masked area'),
            image_path: z.string().describe('Path to the source image'),
            mask_path: z.string().optional().describe('Path to black/white mask image. If omitted, uses alpha channel of source image.'),
            negative_prompt: z.string().max(10000).optional(),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.mask_path) appendFileToForm(form, 'mask', params.mask_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/edit/inpaint', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'inpaint', params.output_format);
        return {
            content: [
                { type: 'text', text: `Inpainted image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: outpaint ─────────────────────────────────────────────────────────────

server.registerTool(
    'outpaint',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Extend an image by adding content in any direction (left, right, up, down). 4 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the source image'),
            left: z.number().int().min(0).max(2000).default(0).describe('Pixels to extend left'),
            right: z.number().int().min(0).max(2000).default(0).describe('Pixels to extend right'),
            up: z.number().int().min(0).max(2000).default(0).describe('Pixels to extend up'),
            down: z.number().int().min(0).max(2000).default(0).describe('Pixels to extend down'),
            prompt: z.string().max(10000).optional().describe('Optional guidance for the extended content'),
            creativity: z.number().min(0).max(1).default(0.5).optional().describe('How creative the extension should be (0-1)'),
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        if (params.left === 0 && params.right === 0 && params.up === 0 && params.down === 0) {
            return { content: [{ type: 'text', text: 'Error: At least one direction (left, right, up, down) must be > 0' }] };
        }

        const form = new FormData();
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.left > 0) form.append('left', String(params.left));
        if (params.right > 0) form.append('right', String(params.right));
        if (params.up > 0) form.append('up', String(params.up));
        if (params.down > 0) form.append('down', String(params.down));
        if (params.prompt) form.append('prompt', params.prompt);
        if (params.creativity !== undefined) form.append('creativity', String(params.creativity));
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/edit/outpaint', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'outpaint', params.output_format);
        return {
            content: [
                { type: 'text', text: `Outpainted image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: erase ────────────────────────────────────────────────────────────────

server.registerTool(
    'erase',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Remove unwanted objects from an image using a mask. White mask pixels indicate areas to erase. 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the source image'),
            mask_path: z.string().optional().describe('Path to black/white mask image. If omitted, uses alpha channel of source image.'),
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.mask_path) appendFileToForm(form, 'mask', params.mask_path);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/edit/erase', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'erase', params.output_format);
        return {
            content: [
                { type: 'text', text: `Erased image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: search_and_replace ───────────────────────────────────────────────────

server.registerTool(
    'search_and_replace',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Automatically find an object in an image and replace it with something else. No mask needed. 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the source image'),
            prompt: z.string().min(1).max(10000).describe('What to replace the found object with'),
            search_prompt: z.string().max(10000).describe('Short description of the object to find and replace'),
            negative_prompt: z.string().max(10000).optional(),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('search_prompt', params.search_prompt);
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/edit/search-and-replace', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'search-replace', params.output_format);
        return {
            content: [
                { type: 'text', text: `Search-and-replace image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: search_and_recolor ───────────────────────────────────────────────────

server.registerTool(
    'search_and_recolor',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Find an object in an image and change its color. 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the source image'),
            prompt: z.string().min(1).max(10000).describe('Description including the desired color (e.g., "a red car")'),
            select_prompt: z.string().max(10000).describe('Short description of the object to recolor (e.g., "car")'),
            negative_prompt: z.string().max(10000).optional(),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('select_prompt', params.select_prompt);
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/edit/search-and-recolor', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'recolor', params.output_format);
        return {
            content: [
                { type: 'text', text: `Recolored image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: remove_background ────────────────────────────────────────────────────

server.registerTool(
    'remove_background',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Remove the background from an image. Output is always PNG or WebP (supports transparency). 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the source image'),
            output_format: z.enum(['png', 'webp']).default('png').describe('Output format (png or webp, must support transparency)'),
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);

        const result = await stabilityPost('/v2beta/stable-image/edit/remove-background', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'no-bg', params.output_format);
        return {
            content: [
                { type: 'text', text: `Background removed. Saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: upscale_image ────────────────────────────────────────────────────────

server.registerTool(
    'upscale_image',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Upscale an image by 4x using the fast upscaler (~1 second). 2 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the image to upscale (32-1536px per side)'),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);

        const result = await stabilityPost('/v2beta/stable-image/upscale/fast', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'upscaled', params.output_format);
        return {
            content: [
                { type: 'text', text: `Image upscaled 4x and saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: control_sketch ───────────────────────────────────────────────────────

server.registerTool(
    'control_sketch',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Generate a refined image from a sketch or use contour lines from an image. 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the sketch or image'),
            prompt: z.string().min(1).max(10000).describe('What the refined image should look like'),
            control_strength: z.number().min(0).max(1).default(0.7).describe('How much the sketch influences the output (0-1)'),
            negative_prompt: z.string().max(10000).optional(),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('control_strength', String(params.control_strength));
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/control/sketch', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'sketch', params.output_format);
        return {
            content: [
                { type: 'text', text: `Sketch-to-image result saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Tool: control_structure ────────────────────────────────────────────────────

server.registerTool(
    'control_structure',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Generate an image that maintains the structure/layout of a reference image. Great for recreating scenes. 5 credits.',
        inputSchema: {
            image_path: z.string().describe('Path to the structure reference image'),
            prompt: z.string().min(1).max(10000).describe('What the output should look like'),
            control_strength: z.number().min(0).max(1).default(0.7).describe('How much the structure influences the output (0-1)'),
            negative_prompt: z.string().max(10000).optional(),
            style_preset: stylePresetSchema,
            seed: z.number().int().min(0).max(4294967294).optional(),
            output_format: outputFormatSchema,
        },
    },
    async (params) => {
        const form = new FormData();
        form.append('prompt', params.prompt);
        form.append('control_strength', String(params.control_strength));
        form.append('output_format', params.output_format);
        appendFileToForm(form, 'image', params.image_path);
        if (params.negative_prompt) form.append('negative_prompt', params.negative_prompt);
        if (params.style_preset) form.append('style_preset', params.style_preset);
        if (params.seed !== undefined) form.append('seed', String(params.seed));

        const result = await stabilityPost('/v2beta/stable-image/control/structure', form);
        if (!result.ok) return { content: [{ type: 'text', text: result.error }] };

        const filepath = await saveImage(result.data, 'structure', params.output_format);
        return {
            content: [
                { type: 'text', text: `Structure-guided image saved to: ${filepath}` },
                { type: 'image', data: result.data.toString('base64'), mimeType: `image/${params.output_format}` },
            ],
        };
    }
);

// ── Start server ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Stability AI MCP server running on stdio');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
