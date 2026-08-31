import { Hono } from 'hono'
import { createMcpHandler } from 'mcp-handler'
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
        const data = await discord(`/guilds/${guildId}`)
        return result(data)
      }
    )

    // =========================
    // CHANNELS
    // =========================

    server.tool(
      'list_channels',
      'List all channels and categories in the Discord server',
      {},
      async () => {
        const { guildId } = getConfig()
        const data = await discord(`/guilds/${guildId}/channels`)
        return result(data)
      }
    )

    server.tool(
      'create_category',
      'Create a new Discord category',
      {
        name: z.string().min(1).max(100).describe('Category name'),
      },
      async ({ name }) => {
        const { guildId } = getConfig()

        const data = await discord(`/guilds/${guildId}/channels`, {
          method: 'POST',
          body: JSON.stringify({
            name,
            type: 4,
          }),
        })

        return result(data)
      }
    )

    server.tool(
      'create_text_channel',
      'Create a Discord text channel, optionally inside a category',
      {
        name: z.string().min(1).max(100).describe('Channel name'),
        category_id: z
          .string()
          .optional()
          .describe('Category channel ID'),
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

        const data = await discord(`/guilds/${guildId}/channels`, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return result(data)
      }
    )

    server.tool(
      'create_voice_channel',
      'Create a Discord voice channel, optionally inside a category',
      {
        name: z.string().min(1).max(100).describe('Channel name'),
        category_id: z
          .string()
          .optional()
          .describe('Category channel ID'),
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

        const data = await discord(`/guilds/${guildId}/channels`, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return result(data)
      }
    )

    server.tool(
      'edit_channel',
      'Edit a Discord channel or move it to another category',
      {
        channel_id: z.string().describe('Channel ID'),
        name: z.string().optional().describe('New channel name'),
        category_id: z
          .string()
          .nullable()
          .optional()
          .describe('New category ID, or null to remove category'),
        topic: z
          .string()
          .nullable()
          .optional()
          .describe('Text channel topic'),
      },
      async ({ channel_id, name, category_id, topic }) => {
        const body: Record<string, unknown> = {}

        if (name !== undefined) body.name = name
        if (category_id !== undefined) body.parent_id = category_id
        if (topic !== undefined) body.topic = topic

        const data = await discord(`/channels/${channel_id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })

        return result(data)
      }
    )

    server.tool(
      'delete_channel',
      'Delete a Discord channel or category',
      {
        channel_id: z.string().describe('Channel or category ID'),
      },
      async ({ channel_id }) => {
        const data = await discord(`/channels/${channel_id}`, {
          method: 'DELETE',
        })

        return result(data)
      }
    )

    // =========================
    // ROLES
    // =========================

    server.tool(
      'list_roles',
      'List all roles in the Discord server',
      {},
      async () => {
        const { guildId } = getConfig()
        const data = await discord(`/guilds/${guildId}/roles`)
        return result(data)
      }
    )

    server.tool(
      'create_role',
      'Create a new Discord role',
      {
        name: z.string().min(1).max(100).describe('Role name'),
        color: z
          .number()
          .int()
          .min(0)
          .max(16777215)
          .optional()
          .describe('Decimal RGB color'),
        hoist: z
          .boolean()
          .optional()
          .describe('Show role separately in member list'),
        mentionable: z
          .boolean()
          .optional()
          .describe('Allow this role to be mentioned'),
      },
      async ({ name, color, hoist, mentionable }) => {
        const { guildId } = getConfig()

        const body: Record<string, unknown> = { name }

        if (color !== undefined) body.color = color
        if (hoist !== undefined) body.hoist = hoist
        if (mentionable !== undefined) body.mentionable = mentionable

        const data = await discord(`/guilds/${guildId}/roles`, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return result(data)
      }
    )

    server.tool(
      'edit_role',
      'Edit an existing Discord role',
      {
        role_id: z.string().describe('Role ID'),
        name: z.string().optional().describe('New role name'),
        color: z
          .number()
          .int()
          .min(0)
          .max(16777215)
          .optional()
          .describe('Decimal RGB color'),
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
        const { guildId } = getConfig()

        const body: Record<string, unknown> = {}

        if (name !== undefined) body.name = name
        if (color !== undefined) body.color = color
        if (hoist !== undefined) body.hoist = hoist
        if (mentionable !== undefined) body.mentionable = mentionable

        const data = await discord(
          `/guilds/${guildId}/roles/${role_id}`,
          {
            method: 'PATCH',
            body: JSON.stringify(body),
          }
        )

        return result(data)
      }
    )

    server.tool(
      'delete_role',
      'Delete a Discord role',
      {
        role_id: z.string().describe('Role ID'),
      },
      async ({ role_id }) => {
        const { guildId } = getConfig()

        const data = await discord(
          `/guilds/${guildId}/roles/${role_id}`,
          {
            method: 'DELETE',
          }
        )

        return result(data)
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

app.all('/mcp/*', async (c) => {
  return await handler(c.req.raw)
})

app.get('/', (c) => {
  return c.json({
    message: 'Discord Management MCP Server',
    mcp: '/mcp',
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
