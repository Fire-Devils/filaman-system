# MCP read tools for integration plugins

An integration plugin can add read tools to FilaMan's built-in `/mcp` server. A tool must be declared by a mounted plugin, explicitly allowlisted by the operator, and permitted by the caller's FilaMan roles and API key scopes.

Enable the built-in server under **Admin → App Settings → AI Assistants (MCP)**. Set `MCP_PLUGIN_READ_TOOLS` in the FilaMan process environment and restart FilaMan. For Docker Compose, set it in `.env` and run `docker compose up -d` to apply the changed environment. Use a comma-separated list of exact names. An empty list exposes no plugin tools. A plugin with key `example_plugin` declaring the tool below uses:

```dotenv
MCP_PLUGIN_READ_TOOLS=example_plugin-lookup
```

Connect your MCP client to `/mcp` with `Authorization: ApiKey <FilaMan API key>`. A tool disappears from discovery and stops accepting new calls when its plugin is disabled or uninstalled. Native write tools still depend on the built-in server's **Allow write access** setting.

For plugin authors, export a dictionary named `mcp_read_tools` from the integration plugin's `router.py`. FilaMan prefixes each name with the plugin key and a hyphen. Declare one existing `:read` permission, a Pydantic object model with `extra="forbid"`, and an async handler taking the validated arguments, a database session and the authenticated principal. Return JSON-compatible data. The host gives the handler up to 60 seconds.

FilaMan processes JSON-RPC batches in order with a shared 90-second deadline. A batch that reaches the deadline returns completed results and distinguishes the interrupted request from requests that never started. Check whether an interrupted write took effect before retrying it. Send long-running reads as separate MCP requests when each needs its own deadline.

```python
from pydantic import BaseModel, ConfigDict


class LookupArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str


async def lookup(args, db, principal):
    return {"query": args.query}


mcp_read_tools = {
    "lookup": {
        "description": "Look up a value.",
        "permission": "filaments:read",
        "arguments": LookupArgs,
        "handler": lookup,
    },
}
```

Installed Python plugins run in the FilaMan process. The allowlist controls MCP exposure and cannot sandbox a plugin. Enable tools only from plugin versions you trust, keep handlers free of inventory writes, and treat any returned web content as untrusted data. Handlers must perform their own setup and checks, yield during long-running work, and honor cancellation for deadlines to take effect. They receive the authenticated principal, with no raw API key or browser cookies.
