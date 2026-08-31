import { Hono } from 'hono'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import type { AuthInfo } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const app = new Hono()

const DISCORD_API = 'https://discord.com/api/v10'

function getConfig() {
  const token = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.DISCORD_GUILD_ID

  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN')
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID')

  return { token, guildId }
}

async function discord(
  path: string,
  options: RequestInit = {}
) {
  const { token } = getConfig()

  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status}: ${text || response.statusText}`
    )
  }

  return text ? JSON.parse(text) : { success: true }
}

function result(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  }
}

/* =========================================================
   MCP SERVER
   ========================================================= */

const handler = createMcpHandler(
  (server) => {

    // =========================
    // SERVER
    // =========================

    server.tool(
      'get_server',
      'Get Discord server information',
      {},
      async () => {
        const { guildId } = getConfig()
        return result(await discord(`/guilds/${guildId}`))
      }
    )

    // =========================
    // CHANNELS
    // =========================

    server.tool(
      'list_channels',
      'List all channels and categories',
      {},
      async () => {
        const { guildId } = getConfig()
        return result(await discord(`/guilds/${guildId}/channels`))
      }
    )

    server.tool(
      'create_category',
      'Create a new Discord category',
      {
        name: z.string().min(1).max(100),
      },
      async ({ name }) => {
        const { guildId } = getConfig()

        return result(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify({
              name,
              type: 4,
            }),
          })
        )
      }
    )

    server.tool(
      'create_text_channel',
      'Create a Discord text channel',
      {
        name: z.string().min(1).max(100),
        category_id: z.string().optional(),
      },
      async ({ name, category_id }) => {
        const { guildId } = getConfig()

        const body: Record<string, unknown> = {
          name,
          type: 0,
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return result(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'create_voice_channel',
      'Create a Discord voice channel',
      {
        name: z.string().min(1).max(100),
        category_id: z.string().optional(),
      },
      async ({ name, category_id }) => {
        const { guildId } = getConfig()

        const body: Record<string, unknown> = {
          name,
          type: 2,
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return result(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'edit_channel',
      'Edit a Discord channel',
      {
        channel_id: z.string(),
        name: z.string().optional(),
        category_id: z.string().nullable().optional(),
        topic: z.string().nullable().optional(),
      },
      async ({
        channel_id,
        name,
        category_id,
        topic,
      }) => {
        const body: Record<string, unknown> = {}

        if (name !== undefined) body.name = name
        if (category_id !== undefined) {
          body.parent_id = category_id
        }
        if (topic !== undefined) {
          body.topic = topic
        }

        return result(
          await discord(`/channels/${channel_id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'delete_channel',
      'Delete a Discord channel',
      {
        channel_id: z.string(),
      },
      async ({ channel_id }) => {
        return result(
          await discord(`/channels/${channel_id}`, {
            method: 'DELETE',
          })
        )
      }
    )

    // =========================
    // ROLES
    // =========================

    server.tool(
      'list_roles',
      'List all roles',
      {},
      async () => {
        const { guildId } = getConfig()
        return result(await discord(`/guilds/${guildId}/roles`))
      }
    )

    server.tool(
      'create_role',
      'Create a new Discord role',
      {
        name: z.string().min(1).max(100),
        color: z.number().int().min(0).max(16777215).optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
      },
      async ({
        name,
        color,
        hoist,
        mentionable,
      }) => {
        const { guildId } = getConfig()

        const body: Record<string, unknown> = { name }

        if (color !== undefined) body.color = color
        if (hoist !== undefined) body.hoist = hoist
        if (mentionable !== undefined) {
          body.mentionable = mentionable
        }

        return result(
          await discord(`/guilds/${guildId}/roles`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'edit_role',
      'Edit an existing Discord role',
      {
        role_id: z.string(),
        name: z.string().optional(),
        color: z.number().int().min(0).max(16777215).optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
      },
      async ({
        role_id,
        name,
        color,
        hoist,
        mentionable,
      }) => {
        const body: Record<string, unknown> = {}

        if (name !== undefined) body.name = name
        if (color !== undefined) body.color = color
        if (hoist !== undefined) body.hoist = hoist
        if (mentionable !== undefined) {
          body.mentionable = mentionable
        }

        return result(
          await discord(`/guilds/${getConfig().guildId}/roles/${role_id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'delete_role',
      'Delete a Discord role',
      {
        role_id: z.string(),
      },
      async ({ role_id }) => {
        return result(
          await discord(
            `/guilds/${getConfig().guildId}/roles/${role_id}`,
            {
              method: 'DELETE',
            }
          )
        )
      }
    )
  },
  {},
  {
    basePath: '/',
    maxDuration: 60,
    verboseLogs: true,
  }
)

/* =========================================================
   MCP AUTH
   ========================================================= */

const verifyToken = async (
  req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined

  /*
   * Temporary validation.
   *
   * IMPORTANT:
   * Do NOT put the Discord Client Secret in this file.
   *
   * This is only the MCP bearer-token validation layer.
   * Discord OAuth2 verification will be connected separately.
   */

  const expectedToken = process.env.MCP_AUTH_TOKEN

  if (!expectedToken) {
    return undefined
  }

  if (bearerToken !== expectedToken) {
    return undefined
  }

  return {
    token: bearerToken,
    scopes: ['discord'],
    clientId: 'discord-mcp-client',
    extra: {
      authenticated: true,
    },
  }
}

const authHandler = withMcpAuth(
  handler,
  verifyToken,
  {
    required: true,
    requiredScopes: ['discord'],
    resourceMetadataPath:
      '/.well-known/oauth-protected-resource',
  }
)

/* =========================================================
   ROUTES
   ========================================================= */

app.all('/mcp/*', async (c) => {
  return await authHandler(c.req.raw)
})

app.get('/', (c) => {
  return c.json({
    message: 'Discord Management MCP Server',
    mcp: '/mcp',
    authentication: 'OAuth/Bearer protected',
    tools: [
      'get_server',
      'list_channels',
      'create_category',
      'create_text_channel',
      'create_voice_channel',
      'edit_channel',
      'delete_channel',
      'list_roles',
      'create_role',
      'edit_role',
      'delete_role',
    ],
  })
})

export default app
