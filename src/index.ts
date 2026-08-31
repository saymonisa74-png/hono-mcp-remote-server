import { Hono } from 'hono'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'

const app = new Hono()

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_OAUTH = 'https://discord.com/oauth2/authorize'
const DISCORD_TOKEN = 'https://discord.com/api/oauth2/token'

function config() {
  const botToken = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.DISCORD_GUILD_ID
  const clientId = process.env.DISCORD_CLIENT_ID
  const clientSecret = process.env.DISCORD_CLIENT_SECRET

  if (!botToken) throw new Error('Missing DISCORD_BOT_TOKEN')
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID')
  if (!clientId) throw new Error('Missing DISCORD_CLIENT_ID')
  if (!clientSecret) throw new Error('Missing DISCORD_CLIENT_SECRET')

  return { botToken, guildId, clientId, clientSecret }
}

async function discordBot(
  path: string,
  options: RequestInit = {}
) {
  const { botToken } = config()

  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
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

/*
|--------------------------------------------------------------------------
| OAuth2
|--------------------------------------------------------------------------
*/

const CALLBACK_PATH = '/oauth/callback'

function getBaseUrl(req: Request) {
  const url = new URL(req.url)
  return `${url.protocol}//${url.host}`
}

/*
 * Start OAuth login.
 *
 * Claude sends:
 * /oauth/authorize?client_id=...&redirect_uri=...&state=...
 */
app.get('/oauth/authorize', (c) => {
  const { clientId } = config()

  const redirectUri = c.req.query('redirect_uri')
  const state = c.req.query('state')

  if (!redirectUri) {
    return c.text('Missing redirect_uri', 400)
  }

  if (!state) {
    return c.text('Missing state', 400)
  }

  const callback = `${getBaseUrl(c.req.raw)}${CALLBACK_PATH}`

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: callback,
    scope: 'identify',
    state: Buffer.from(
      JSON.stringify({
        redirectUri,
        state,
      })
    ).toString('base64url'),
  })

  return c.redirect(`${DISCORD_OAUTH}?${params.toString()}`)
})

/*
 * Discord redirects here after user authorization.
 */
app.get(CALLBACK_PATH, async (c) => {
  const { clientId, clientSecret } = config()

  const code = c.req.query('code')
  const encodedState = c.req.query('state')

  if (!code || !encodedState) {
    return c.text('OAuth authorization failed', 400)
  }

  try {
    const stateData = JSON.parse(
      Buffer.from(encodedState, 'base64url').toString()
    )

    const callback = `${getBaseUrl(c.req.raw)}${CALLBACK_PATH}`

    /*
     * Exchange Discord authorization code.
     */
    const tokenResponse = await fetch(DISCORD_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
      }),
    })

    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok) {
      return c.json(tokenData, 400)
    }

    /*
     * Create a short-lived MCP authorization code.
     *
     * This implementation uses a signed-looking encoded payload.
     * For production multi-user use, replace this with persistent
     * one-time storage.
     */
    const mcpCode = Buffer.from(
      JSON.stringify({
        access_token: tokenData.access_token,
        expires_in: tokenData.expires_in ?? 3600,
        created_at: Date.now(),
      })
    ).toString('base64url')

    const redirect = new URL(stateData.redirectUri)

    redirect.searchParams.set('code', mcpCode)
    redirect.searchParams.set('state', stateData.state)

    return c.redirect(redirect.toString())
  } catch {
    return c.text('OAuth callback failed', 400)
  }
})

/*
 * Claude exchanges the MCP authorization code for an access token.
 */
app.post('/oauth/token', async (c) => {
  try {
    const body = await c.req.parseBody()
    const code = String(body.code || '')

    if (!code) {
      return c.json(
        {
          error: 'invalid_request',
          error_description: 'Missing code',
        },
        400
      )
    }

    const data = JSON.parse(
      Buffer.from(code, 'base64url').toString()
    )

    if (!data.access_token) {
      return c.json(
        {
          error: 'invalid_grant',
        },
        400
      )
    }

    return c.json({
      access_token: data.access_token,
      token_type: 'Bearer',
      expires_in: data.expires_in ?? 3600,
    })
  } catch {
    return c.json(
      {
        error: 'invalid_grant',
      },
      400
    )
  }
})

/*
|--------------------------------------------------------------------------
| Verify Discord OAuth access token
|--------------------------------------------------------------------------
*/

async function verifyOAuthToken(token?: string) {
  if (!token) return false

  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  return response.ok
}

/*
|--------------------------------------------------------------------------
| MCP tools
|--------------------------------------------------------------------------
*/

const handler = createMcpHandler(
  (server) => {

    server.tool(
      'get_server',
      'Get Discord server information',
      {},
      async () => {
        const { guildId } = config()
        return result(
          await discordBot(`/guilds/${guildId}`)
        )
      }
    )

    server.tool(
      'list_channels',
      'List all Discord channels and categories',
      {},
      async () => {
        const { guildId } = config()
        return result(
          await discordBot(`/guilds/${guildId}/channels`)
        )
      }
    )

    server.tool(
      'create_category',
      'Create a Discord category',
      {
        name: z.string().min(1).max(100),
      },
      async ({ name }) => {
        const { guildId } = config()

        return result(
          await discordBot(`/guilds/${guildId}/channels`, {
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
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name,
          type: 0,
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return result(
          await discordBot(`/guilds/${guildId}/channels`, {
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
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name,
          type: 2,
        }

        if (category_id) {
          body.parent_id = category_id
        }

        return result(
          await discordBot(`/guilds/${guildId}/channels`, {
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
        if (category_id !== undefined) body.parent_id = category_id
        if (topic !== undefined) body.topic = topic

        return result(
          await discordBot(`/channels/${channel_id}`, {
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
          await discordBot(`/channels/${channel_id}`, {
            method: 'DELETE',
          })
        )
      }
    )

    server.tool(
      'list_roles',
      'List Discord server roles',
      {},
      async () => {
        const { guildId } = config()

        return result(
          await discordBot(`/guilds/${guildId}/roles`)
        )
      }
    )

    server.tool(
      'create_role',
      'Create a Discord role',
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
        const { guildId } = config()

        const body: Record<string, unknown> = {
          name,
        }

        if (color !== undefined) body.color = color
        if (hoist !== undefined) body.hoist = hoist
        if (mentionable !== undefined) {
          body.mentionable = mentionable
        }

        return result(
          await discordBot(`/guilds/${guildId}/roles`, {
            method: 'POST',
            body: JSON.stringify(body),
          })
        )
      }
    )

    server.tool(
      'edit_role',
      'Edit a Discord role',
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
          await discordBot(
            `/guilds/${config().guildId}/roles/${role_id}`,
            {
              method: 'PATCH',
              body: JSON.stringify(body),
            }
          )
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
          await discordBot(
            `/guilds/${config().guildId}/roles/${role_id}`,
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

/*
|--------------------------------------------------------------------------
| MCP authentication
|--------------------------------------------------------------------------
*/

app.all('/mcp/*', async (c) => {
  const auth = c.req.header('Authorization')

  if (!auth?.startsWith('Bearer ')) {
    return c.json(
      {
        error: 'unauthorized',
        message: 'OAuth authentication required',
      },
      401,
      {
        'WWW-Authenticate':
          'Bearer realm="Discord MCP"',
      }
    )
  }

  const token = auth.slice(7)

  if (!(await verifyOAuthToken(token))) {
    return c.json(
      {
        error: 'invalid_token',
      },
      401,
      {
        'WWW-Authenticate':
          'Bearer realm="Discord MCP"',
      }
    )
  }

  return handler(c.req.raw)
})

/*
|--------------------------------------------------------------------------
| OAuth metadata
|--------------------------------------------------------------------------
*/

app.get(
  '/.well-known/oauth-protected-resource',
  (c) => {
    const base = getBaseUrl(c.req.raw)

    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
    })
  }
)

app.get(
  '/.well-known/oauth-authorization-server',
  (c) => {
    const base = getBaseUrl(c.req.raw)

    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: [
        'none',
      ],
      code_challenge_methods_supported: ['S256'],
    })
  }
)

app.get('/', (c) => {
  return c.json({
    message: 'Discord Management MCP Server',
    endpoint: '/mcp',
    oauth: {
      authorize: '/oauth/authorize',
      token: '/oauth/token',
      callback: '/oauth/callback',
    },
  })
})

export default app
