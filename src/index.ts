import { Hono } from 'hono'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'

const app = new Hono()

const DISCORD_API = 'https://discord.com/api/v10'

function config() {
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
  const { token } = config()

  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status}: ${text || response.statusText}`
    )
  }

  return text ? JSON.parse(text) : { success: true }
}

function output(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  }
}

const handler = createMcpHandler(
  (server) => {

    // =========================
    // SERVER
    // =========================

    server.tool(
      'get_server',
      'Get information about the configured Discord server.',
      {},
      async () => {
        const { guildId } = config()
        return output(
          await discord(`/guilds/${guildId}`)
        )
      }
    )

    // =========================
    // CHANNELS
    // =========================

    server.tool(
      'list_channels',
      'List all Discord channels and categories.',
      {},
      async () => {
        const { guildId } = config()
        return output(
          await discord(`/guilds/${guildId}/channels`)
        )
      }
    )

    server.tool(
      'create_category',
      'Create a Discord category.',
      {
        name: z.string().min(1).max(100)
      },
      async ({ name }) => {
        const { guildId } = config()

        return output(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify({
              name,
              type: 4
            })
          })
        )
      }
    )

    server.tool(
      'create_text_channel',
      'Create a Discord text channel.',
      {
        name: z.string().min(1).max(100),
        category_id: z.string().optional()
      },
      async ({ name, category_id }) => {
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name,
          type: 0
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return output(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify(body)
          })
        )
      }
    )

    server.tool(
      'create_voice_channel',
      'Create a Discord voice channel.',
      {
        name: z.string().min(1).max(100),
        category_id: z.string().optional()
      },
      async ({ name, category_id }) => {
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name,
          type: 2
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return output(
          await discord(`/guilds/${guildId}/channels`, {
            method: 'POST',
            body: JSON.stringify(body)
          })
        )
      }
    )

    server.tool(
      'edit_channel',
      'Rename or move a Discord channel.',
      {
        channel_id: z.string(),
        name: z.string().optional(),
        category_id: z.string().nullable().optional(),
        topic: z.string().nullable().optional()
      },
      async ({
        channel_id,
        name,
        category_id,
        topic
      }) => {
        const body: Record<string, unknown> = {}

        if (name !== undefined) {
          body.name = name
        }

        if (category_id !== undefined) {
          body.parent_id = category_id
        }

        if (topic !== undefined) {
          body.topic = topic
        }

        return output(
          await discord(`/channels/${channel_id}`, {
            method: 'PATCH',
            body: JSON.stringify(body)
          })
        )
      }
    )

    server.tool(
      'delete_channel',
      'Delete a Discord channel or category.',
      {
        channel_id: z.string()
      },
      async ({ channel_id }) => {
        return output(
          await discord(`/channels/${channel_id}`, {
            method: 'DELETE'
          })
        )
      }
    )

    // =========================
    // ROLES
    // =========================

    server.tool(
      'list_roles',
      'List all Discord roles.',
      {},
      async () => {
        const { guildId } = config()

        return output(
          await discord(`/guilds/${guildId}/roles`)
        )
      }
    )

    server.tool(
      'create_role',
      'Create a Discord role.',
      {
        name: z.string().min(1).max(100),
        color: z.number().int().min(0).max(16777215).optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional()
      },
      async ({
        name,
        color,
        hoist,
        mentionable
      }) => {
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name
        }

        if (color !== undefined) {
          body.color = color
        }

        if (hoist !== undefined) {
          body.hoist = hoist
        }

        if (mentionable !== undefined) {
          body.mentionable = mentionable
        }

        return output(
          await discord(`/guilds/${guildId}/roles`, {
            method: 'POST',
            body: JSON.stringify(body)
          })
        )
      }
    )

    server.tool(
      'edit_role',
      'Edit an existing Discord role.',
      {
        role_id: z.string(),
        name: z.string().optional(),
        color: z.number().int().min(0).max(16777215).optional(),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional()
      },
      async ({
        role_id,
        name,
        color,
        hoist,
        mentionable
      }) => {
        const body: Record<string, unknown> = {}

        if (name !== undefined) {
          body.name = name
        }

        if (color !== undefined) {
          body.color = color
        }

        if (hoist !== undefined) {
          body.hoist = hoist
        }

        if (mentionable !== undefined) {
          body.mentionable = mentionable
        }

        const { guildId } = config()

        return output(
          await discord(
            `/guilds/${guildId}/roles/${role_id}`,
            {
              method: 'PATCH',
              body: JSON.stringify(body)
            }
          )
        )
      }
    )

    server.tool(
      'delete_role',
      'Delete a Discord role.',
      {
        role_id: z.string()
      },
      async ({ role_id }) => {
        const { guildId } = config()

        return output(
          await discord(
            `/guilds/${guildId}/roles/${role_id}`,
            {
              method: 'DELETE'
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
    verboseLogs: true
  }
)

app.all('/mcp/*', async (c) => {
  return await handler(c.req.raw)
})

app.get('/', (c) => {
  return c.json({
    message: 'Discord Management MCP Server',
    endpoint: '/mcp',
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
      'delete_role'
    ]
  })
})

export default app
