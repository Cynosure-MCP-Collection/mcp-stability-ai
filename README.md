# @cynosure-mcp/stability-ai

MCP server for Stability AI image generation, editing, and upscaling.

## Installation

```bash
npx @cynosure-mcp/stability-ai
```

Or install globally:

```bash
npm install -g @cynosure-mcp/stability-ai
stability-ai
```

## Tools

| Tool                 | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `generate_image`     | Text-to-image generation (ultra, core, sd3.5 models)               |
| `image_to_image`     | Generate from a prompt using an existing image as a starting point |
| `inpaint`            | Fill or replace masked areas of an image                           |
| `outpaint`           | Extend an image in any direction                                   |
| `erase`              | Remove objects from an image using a mask                          |
| `search_and_replace` | Auto-find and replace objects in an image                          |
| `search_and_recolor` | Change the color of a specific object                              |
| `remove_background`  | Remove the background from an image                                |
| `control_sketch`     | Refine a rough sketch into a full image                            |
| `control_structure`  | Generate while maintaining the structure of a reference image      |
| `upscale_image`      | 4× fast upscale (~1 second)                                        |

## Configuration

| Variable               | Required | Description                                                                      |
| ---------------------- | -------- | -------------------------------------------------------------------------------- |
| `STABILITY_API_KEY`    | Yes      | API key from [platform.stability.ai](https://platform.stability.ai/account/keys) |
| `STABILITY_OUTPUT_DIR` | No       | Directory for generated images (default: OS temp directory)                      |

## MCP Config

```json
{
  "mcpServers": {
    "stability-ai": {
      "command": "npx",
      "args": ["@cynosure-mcp/stability-ai"],
      "env": {
        "STABILITY_API_KEY": "your-api-key"
      }
    }
  }
}
```

## License

MIT
