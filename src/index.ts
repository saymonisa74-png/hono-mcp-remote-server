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

/**
 * Core Discord REST call using the bot token.
 * Never leaks the token itself in results or errors.
 * Handles 429 (rate limit) with a single bounded wait-and-retry,
 * and turns other non-2xx responses into readable errors.
 */
async function discordBot(
  path: string,
  options: RequestInit = {},
  _retried = false
): Promise<unknown> {
  const { botToken } = config()

  const response = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  if (response.status === 429 && !_retried) {
    const text = await response.text()
    let retryAfterMs = 1000
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed.retry_after === 'number') {
        retryAfterMs = Math.min(parsed.retry_after * 1000, 5000)
      }
    } catch {
      // ignore parse failure, use default backoff
    }
    await new Promise((r) => setTimeout(r, retryAfterMs))
    return discordBot(path, options, true)
  }

  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status} on ${options.method || 'GET'} ${path}: ${
        redactSecrets(text) || response.statusText
      }`
    )
  }

  if (response.status === 204 || !text) {
    return { success: true }
  }

  return JSON.parse(text)
}

/**
 * Multipart form-data variant, required for endpoints that accept
 * file uploads (e.g. stickers). Accepts a base64 data payload.
 */
async function discordBotForm(
  path: string,
  method: string,
  fields: Record<string, string>,
  file: { base64: string; filename: string; contentType: string }
): Promise<unknown> {
  const { botToken } = config()

  const binary = Buffer.from(file.base64, 'base64')
  const blob = new Blob([binary], { type: file.contentType })

  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value)
  }
  form.append('file', blob, file.filename)

  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: { Authorization: `Bot ${botToken}` },
    body: form,
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(
      `Discord API ${response.status} on ${method} ${path}: ${
        redactSecrets(text) || response.statusText
      }`
    )
  }

  return text ? JSON.parse(text) : { success: true }
}

/** Strip anything that looks like a token/secret before it can reach a result or error. */
function redactSecrets(text: string) {
  return text
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(process.env.DISCORD_BOT_TOKEN || '\u0000', '[redacted]')
    .replace(process.env.DISCORD_CLIENT_SECRET || '\u0000', '[redacted]')
}

function result(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true as const,
  }
}

/** Wraps a tool handler so Discord API errors become clean MCP error results
 *  instead of throwing / leaking raw stack traces. */
function safe<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return result(await fn(args))
    } catch (err) {
      return errorResult(redactSecrets(err instanceof Error ? err.message : String(err)))
    }
  }
}

/* =========================================================
   OAuth2  (unchanged from existing implementation)
========================================================= */

const CALLBACK_PATH = '/oauth/callback'

function getBaseUrl(req: Request) {
  const url = new URL(req.url)
  return `${url.protocol}//${url.host}`
}

app.get('/oauth/authorize', (c) => {
  const { clientId } = config()
  const redirectUri = c.req.query('redirect_uri')
  const state = c.req.query('state')

  if (!redirectUri) return c.text('Missing redirect_uri', 400)
  if (!state) return c.text('Missing state', 400)

  const callback = `${getBaseUrl(c.req.raw)}${CALLBACK_PATH}`

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: callback,
    scope: 'identify',
    state: Buffer.from(JSON.stringify({ redirectUri, state })).toString('base64url'),
  })

  return c.redirect(`${DISCORD_OAUTH}?${params.toString()}`)
})

app.get(CALLBACK_PATH, async (c) => {
  const { clientId, clientSecret } = config()
  const code = c.req.query('code')
  const encodedState = c.req.query('state')

  if (!code || !encodedState) return c.text('OAuth authorization failed', 400)

  try {
    const stateData = JSON.parse(Buffer.from(encodedState, 'base64url').toString())
    const callback = `${getBaseUrl(c.req.raw)}${CALLBACK_PATH}`

    const tokenResponse = await fetch(DISCORD_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
      }),
    })

    const tokenData = await tokenResponse.json()
    if (!tokenResponse.ok) return c.json(tokenData, 400)

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

app.post('/oauth/token', async (c) => {
  try {
    const body = await c.req.parseBody()
    const code = String(body.code || '')
    if (!code) {
      return c.json({ error: 'invalid_request', error_description: 'Missing code' }, 400)
    }

    const data = JSON.parse(Buffer.from(code, 'base64url').toString())
    if (!data.access_token) return c.json({ error: 'invalid_grant' }, 400)

    return c.json({
      access_token: data.access_token,
      token_type: 'Bearer',
      expires_in: data.expires_in ?? 3600,
    })
  } catch {
    return c.json({ error: 'invalid_grant' }, 400)
  }
})

async function verifyOAuthToken(token?: string) {
  if (!token) return false
  const response = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.ok
}

/* =========================================================
   MCP TOOLS
========================================================= */

const handler = createMcpHandler(
  (server) => {
    const g = () => config().guildId

    /* ===================== GUILD / SERVER ===================== */

    server.tool('guild_get', 'Get complete Discord server information', {
      with_counts: z.boolean().optional().describe('Include approximate member/presence counts'),
    }, safe(async ({ with_counts }: { with_counts?: boolean }) =>
      discordBot(`/guilds/${g()}${with_counts ? '?with_counts=true' : ''}`)
    ))

    server.tool('guild_edit', 'Edit server settings (name, description, verification level, etc.)', {
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      verification_level: z.number().int().min(0).max(4).optional(),
      default_message_notifications: z.number().int().min(0).max(1).optional(),
      explicit_content_filter: z.number().int().min(0).max(2).optional(),
      afk_channel_id: z.string().nullable().optional(),
      afk_timeout: z.number().int().optional(),
      system_channel_id: z.string().nullable().optional(),
      rules_channel_id: z.string().nullable().optional(),
      public_updates_channel_id: z.string().nullable().optional(),
      preferred_locale: z.string().optional(),
    }, safe(async (body: Record<string, unknown>) =>
      discordBot(`/guilds/${g()}`, { method: 'PATCH', body: JSON.stringify(body) })
    ))

    server.tool('guild_audit_log', 'View the server audit log', {
      action_type: z.number().int().optional(),
      user_id: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }, safe(async (q: Record<string, unknown>) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v))
      const qs = params.toString()
      return discordBot(`/guilds/${g()}/audit-logs${qs ? `?${qs}` : ''}`)
    }))

    server.tool('guild_vanity_url', 'Get the server vanity invite URL (if the server has one)', {},
      safe(async () => discordBot(`/guilds/${g()}/vanity-url`)))

    server.tool('guild_widget_get', 'Get the server widget settings', {},
      safe(async () => discordBot(`/guilds/${g()}/widget`)))

    server.tool('guild_widget_edit', 'Edit the server widget settings', {
      enabled: z.boolean().optional(),
      channel_id: z.string().nullable().optional(),
    }, safe(async (body: Record<string, unknown>) =>
      discordBot(`/guilds/${g()}/widget`, { method: 'PATCH', body: JSON.stringify(body) })
    ))

    server.tool('guild_onboarding_get', 'Get the server onboarding configuration', {},
      safe(async () => discordBot(`/guilds/${g()}/onboarding`)))

    server.tool('guild_integrations_list', 'List integrations connected to the server', {},
      safe(async () => discordBot(`/guilds/${g()}/integrations`)))

    /* ===================== CHANNELS ===================== */

    const CHANNEL_TYPES = {
      text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16,
    } as const

    server.tool('channel_list', 'List all channels and categories in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/channels`)))

    server.tool('channel_get', 'Get a single channel by ID', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) => discordBot(`/channels/${channel_id}`)))

    server.tool('channel_create', 'Create a channel or category of any supported type', {
      name: z.string().min(1).max(100),
      type: z.enum(['text', 'voice', 'category', 'announcement', 'forum', 'media', 'stage']),
      category_id: z.string().optional(),
      topic: z.string().max(1024).optional(),
      nsfw: z.boolean().optional(),
      bitrate: z.number().int().optional(),
      user_limit: z.number().int().min(0).max(99).optional(),
      rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
      position: z.number().int().optional(),
    }, safe(async ({ name, type, category_id, topic, nsfw, bitrate, user_limit, rate_limit_per_user, position }:
      { name: string; type: keyof typeof CHANNEL_TYPES; category_id?: string; topic?: string; nsfw?: boolean; bitrate?: number; user_limit?: number; rate_limit_per_user?: number; position?: number }) => {
      const body: Record<string, unknown> = { name, type: CHANNEL_TYPES[type] }
      if (category_id) body.parent_id = category_id
      if (topic !== undefined) body.topic = topic
      if (nsfw !== undefined) body.nsfw = nsfw
      if (bitrate !== undefined) body.bitrate = bitrate
      if (user_limit !== undefined) body.user_limit = user_limit
      if (rate_limit_per_user !== undefined) body.rate_limit_per_user = rate_limit_per_user
      if (position !== undefined) body.position = position
      return discordBot(`/guilds/${g()}/channels`, { method: 'POST', body: JSON.stringify(body) })
    }))

    server.tool('channel_edit', 'Edit a channel or category (name, topic, slowmode, nsfw, parent, etc.)', {
      channel_id: z.string(),
      name: z.string().optional(),
      category_id: z.string().nullable().optional(),
      topic: z.string().nullable().optional(),
      nsfw: z.boolean().optional(),
      rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
      position: z.number().int().optional(),
      bitrate: z.number().int().optional(),
      user_limit: z.number().int().min(0).max(99).optional(),
      video_quality_mode: z.number().int().min(1).max(2).optional(),
      default_auto_archive_duration: z.number().int().optional(),
    }, safe(async ({ channel_id, category_id, ...rest }: { channel_id: string; category_id?: string | null; [k: string]: unknown }) => {
      const body: Record<string, unknown> = { ...rest }
      if (category_id !== undefined) body.parent_id = category_id
      return discordBot(`/channels/${channel_id}`, { method: 'PATCH', body: JSON.stringify(body) })
    }))

    server.tool('channel_delete', 'Delete a channel or category', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) =>
      discordBot(`/channels/${channel_id}`, { method: 'DELETE' })))

    server.tool('channel_reorder', 'Reorder / move multiple channels in one request', {
      positions: z.array(z.object({
        channel_id: z.string(),
        position: z.number().int(),
        category_id: z.string().nullable().optional(),
      })).min(1),
    }, safe(async ({ positions }: { positions: Array<{ channel_id: string; position: number; category_id?: string | null }> }) => {
      const body = positions.map((p) => ({
        id: p.channel_id,
        position: p.position,
        ...(p.category_id !== undefined ? { parent_id: p.category_id } : {}),
      }))
      return discordBot(`/guilds/${g()}/channels`, { method: 'PATCH', body: JSON.stringify(body) })
    }))

    server.tool('channel_permissions_get', 'Read the current permission overwrites (role and member) on a channel. Requires VIEW_CHANNEL.', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) => {
      const channel = await discordBot(`/channels/${channel_id}`) as { permission_overwrites?: unknown }
      return { channel_id, permission_overwrites: channel.permission_overwrites ?? [] }
    }))

    server.tool('channel_permission_set', 'Set (allow/deny) a permission overwrite for a role or member on a channel. Requires MANAGE_ROLES on the bot, and the bot can only grant permissions it itself holds.', {
      channel_id: z.string(),
      overwrite_id: z.string().describe('Role ID or member (user) ID'),
      type: z.enum(['role', 'member']),
      allow: z.string().optional().describe('Permission bitfield string to allow'),
      deny: z.string().optional().describe('Permission bitfield string to deny'),
    }, safe(async ({ channel_id, overwrite_id, type, allow, deny }:
      { channel_id: string; overwrite_id: string; type: 'role' | 'member'; allow?: string; deny?: string }) =>
      discordBot(`/channels/${channel_id}/permissions/${overwrite_id}`, {
        method: 'PUT',
        body: JSON.stringify({ type: type === 'role' ? 0 : 1, allow: allow ?? '0', deny: deny ?? '0' }),
      })
    ))

    server.tool('channel_permission_delete', 'Delete a permission overwrite from a channel', {
      channel_id: z.string(),
      overwrite_id: z.string(),
    }, safe(async ({ channel_id, overwrite_id }: { channel_id: string; overwrite_id: string }) =>
      discordBot(`/channels/${channel_id}/permissions/${overwrite_id}`, { method: 'DELETE' })
    ))

    /* ===================== ROLES ===================== */

    server.tool('role_list', 'List all roles in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/roles`)))

    server.tool('role_create', 'Create a role', {
      name: z.string().min(1).max(100),
      color: z.number().int().min(0).max(16777215).optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.string().optional().describe('Permission bitfield string'),
      icon_base64: z.string().optional().describe('Base64 image data for the role icon'),
      unicode_emoji: z.string().optional(),
    }, safe(async (body: Record<string, unknown>) => {
      const { icon_base64, ...rest } = body
      const payload: Record<string, unknown> = { ...rest }
      if (icon_base64) payload.icon = `data:image/png;base64,${icon_base64}`
      return discordBot(`/guilds/${g()}/roles`, { method: 'POST', body: JSON.stringify(payload) })
    }))

    server.tool('role_edit', 'Edit a role, including its permission bitfield. Requires MANAGE_ROLES; the bot can only edit roles below its own highest role, and cannot grant permissions it does not itself hold.', {
      role_id: z.string(),
      name: z.string().optional(),
      color: z.number().int().min(0).max(16777215).optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      permissions: z.string().optional().describe('Full replacement permission bitfield string, e.g. "8" for Administrator'),
    }, safe(async ({ role_id, ...rest }: { role_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/roles/${role_id}`, { method: 'PATCH', body: JSON.stringify(rest) })
    ))

    server.tool('role_delete', 'Delete a role', {
      role_id: z.string(),
    }, safe(async ({ role_id }: { role_id: string }) =>
      discordBot(`/guilds/${g()}/roles/${role_id}`, { method: 'DELETE' })))

    server.tool('role_reorder', 'Reorder multiple roles in one request', {
      positions: z.array(z.object({ role_id: z.string(), position: z.number().int() })).min(1),
    }, safe(async ({ positions }: { positions: Array<{ role_id: string; position: number }> }) =>
      discordBot(`/guilds/${g()}/roles`, {
        method: 'PATCH',
        body: JSON.stringify(positions.map((p) => ({ id: p.role_id, position: p.position }))),
      })
    ))

    server.tool('member_role_add', 'Add a role to a member', {
      user_id: z.string(),
      role_id: z.string(),
    }, safe(async ({ user_id, role_id }: { user_id: string; role_id: string }) =>
      discordBot(`/guilds/${g()}/members/${user_id}/roles/${role_id}`, { method: 'PUT' })))

    server.tool('member_role_remove', 'Remove a role from a member', {
      user_id: z.string(),
      role_id: z.string(),
    }, safe(async ({ user_id, role_id }: { user_id: string; role_id: string }) =>
      discordBot(`/guilds/${g()}/members/${user_id}/roles/${role_id}`, { method: 'DELETE' })))

    /* ===================== MEMBERS ===================== */

    server.tool('member_list', 'List members in the server', {
      limit: z.number().int().min(1).max(1000).optional(),
      after: z.string().optional(),
    }, safe(async ({ limit, after }: { limit?: number; after?: string }) => {
      const params = new URLSearchParams()
      if (limit) params.set('limit', String(limit))
      if (after) params.set('after', after)
      const qs = params.toString()
      return discordBot(`/guilds/${g()}/members${qs ? `?${qs}` : ''}`)
    }))

    server.tool('member_search', 'Search members by username/nickname prefix', {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(1000).optional(),
    }, safe(async ({ query, limit }: { query: string; limit?: number }) => {
      const params = new URLSearchParams({ query })
      if (limit) params.set('limit', String(limit))
      return discordBot(`/guilds/${g()}/members/search?${params.toString()}`)
    }))

    server.tool('member_get', 'Get a single member', {
      user_id: z.string(),
    }, safe(async ({ user_id }: { user_id: string }) => discordBot(`/guilds/${g()}/members/${user_id}`)))

    server.tool('member_edit', 'Edit a member: nickname, roles, voice mute/deafen, timeout, or move to a voice channel', {
      user_id: z.string(),
      nick: z.string().nullable().optional(),
      roles: z.array(z.string()).optional().describe('Full replacement list of role IDs'),
      mute: z.boolean().optional().describe('Server voice mute'),
      deaf: z.boolean().optional().describe('Server voice deafen'),
      channel_id: z.string().nullable().optional().describe('Move member to this voice channel, or null to disconnect'),
      communication_disabled_until: z.string().nullable().optional().describe('ISO8601 timestamp for timeout expiry, or null to remove timeout'),
    }, safe(async ({ user_id, ...rest }: { user_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/members/${user_id}`, { method: 'PATCH', body: JSON.stringify(rest) })
    ))

    server.tool('member_timeout', 'Timeout (communication disable) a member for up to 28 days', {
      user_id: z.string(),
      until: z.string().describe('ISO8601 timestamp, max 28 days from now'),
      reason: z.string().optional(),
    }, safe(async ({ user_id, until, reason }: { user_id: string; until: string; reason?: string }) =>
      discordBot(`/guilds/${g()}/members/${user_id}`, {
        method: 'PATCH',
        headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
        body: JSON.stringify({ communication_disabled_until: until }),
      })
    ))

    server.tool('member_timeout_remove', 'Remove an active timeout from a member', {
      user_id: z.string(),
    }, safe(async ({ user_id }: { user_id: string }) =>
      discordBot(`/guilds/${g()}/members/${user_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ communication_disabled_until: null }),
      })
    ))

    server.tool('member_kick', 'Kick a member from the server', {
      user_id: z.string(),
      reason: z.string().optional(),
    }, safe(async ({ user_id, reason }: { user_id: string; reason?: string }) =>
      discordBot(`/guilds/${g()}/members/${user_id}`, {
        method: 'DELETE',
        headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
      })
    ))

    server.tool('member_ban', 'Ban a member (or a user ID not currently in the server). Requires BAN_MEMBERS; the bot cannot ban a member whose highest role outranks its own.', {
      user_id: z.string(),
      delete_message_seconds: z.number().int().min(0).max(604800).optional(),
      reason: z.string().optional(),
    }, safe(async ({ user_id, delete_message_seconds, reason }: { user_id: string; delete_message_seconds?: number; reason?: string }) =>
      discordBot(`/guilds/${g()}/bans/${user_id}`, {
        method: 'PUT',
        headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
        body: JSON.stringify({ delete_message_seconds: delete_message_seconds ?? 0 }),
      })
    ))

    server.tool('member_unban', 'Remove a ban', {
      user_id: z.string(),
    }, safe(async ({ user_id }: { user_id: string }) =>
      discordBot(`/guilds/${g()}/bans/${user_id}`, { method: 'DELETE' })))

    server.tool('member_ban_list', 'List server bans', {
      limit: z.number().int().min(1).max(1000).optional(),
    }, safe(async ({ limit }: { limit?: number }) =>
      discordBot(`/guilds/${g()}/bans${limit ? `?limit=${limit}` : ''}`)))

    server.tool('member_bulk_ban', 'Ban multiple users at once (up to 200)', {
      user_ids: z.array(z.string()).min(1).max(200),
      delete_message_seconds: z.number().int().min(0).max(604800).optional(),
    }, safe(async ({ user_ids, delete_message_seconds }: { user_ids: string[]; delete_message_seconds?: number }) =>
      discordBot(`/guilds/${g()}/bulk-ban`, {
        method: 'POST',
        body: JSON.stringify({ user_ids, delete_message_seconds: delete_message_seconds ?? 0 }),
      })
    ))

    /* ===================== MESSAGES ===================== */

    server.tool('message_list', 'List recent messages in a channel', {
      channel_id: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      around: z.string().optional(),
    }, safe(async ({ channel_id, ...q }: { channel_id: string; [k: string]: unknown }) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v))
      const qs = params.toString()
      return discordBot(`/channels/${channel_id}/messages${qs ? `?${qs}` : ''}`)
    }))

    server.tool('message_get', 'Get a single message', {
      channel_id: z.string(),
      message_id: z.string(),
    }, safe(async ({ channel_id, message_id }: { channel_id: string; message_id: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}`)))

    server.tool('message_send', 'Send a message to a channel', {
      channel_id: z.string(),
      content: z.string().max(2000).optional(),
      embeds: z.array(z.record(z.unknown())).optional(),
      allowed_mentions: z.record(z.unknown()).optional(),
      reply_to_message_id: z.string().optional(),
      tts: z.boolean().optional(),
    }, safe(async ({ channel_id, reply_to_message_id, ...rest }: { channel_id: string; reply_to_message_id?: string; [k: string]: unknown }) => {
      const body: Record<string, unknown> = { ...rest }
      if (reply_to_message_id) body.message_reference = { message_id: reply_to_message_id }
      return discordBot(`/channels/${channel_id}/messages`, { method: 'POST', body: JSON.stringify(body) })
    }))

    server.tool('message_edit', 'Edit a message previously sent by the bot', {
      channel_id: z.string(),
      message_id: z.string(),
      content: z.string().max(2000).optional(),
      embeds: z.array(z.record(z.unknown())).optional(),
    }, safe(async ({ channel_id, message_id, ...rest }: { channel_id: string; message_id: string; [k: string]: unknown }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}`, { method: 'PATCH', body: JSON.stringify(rest) })
    ))

    server.tool('message_delete', 'Delete a message', {
      channel_id: z.string(),
      message_id: z.string(),
      reason: z.string().optional(),
    }, safe(async ({ channel_id, message_id, reason }: { channel_id: string; message_id: string; reason?: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}`, {
        method: 'DELETE',
        headers: reason ? { 'X-Audit-Log-Reason': reason } : {},
      })
    ))

    server.tool('message_bulk_delete', 'Bulk delete 2-100 messages at once (messages must be under 14 days old)', {
      channel_id: z.string(),
      message_ids: z.array(z.string()).min(2).max(100),
    }, safe(async ({ channel_id, message_ids }: { channel_id: string; message_ids: string[] }) =>
      discordBot(`/channels/${channel_id}/messages/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ messages: message_ids }),
      })
    ))

    server.tool('message_reaction_add', 'Add a reaction to a message (bot reacts)', {
      channel_id: z.string(),
      message_id: z.string(),
      emoji: z.string().describe('Unicode emoji, or name:id for a custom emoji'),
    }, safe(async ({ channel_id, message_id, emoji }: { channel_id: string; message_id: string; emoji: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT' })
    ))

    server.tool('message_reaction_remove', 'Remove a reaction from a message', {
      channel_id: z.string(),
      message_id: z.string(),
      emoji: z.string(),
      user_id: z.string().optional().describe('Omit to remove the bot\'s own reaction'),
    }, safe(async ({ channel_id, message_id, emoji, user_id }: { channel_id: string; message_id: string; emoji: string; user_id?: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}/${user_id ?? '@me'}`, { method: 'DELETE' })
    ))

    server.tool('message_reaction_list', 'List users who reacted with a given emoji', {
      channel_id: z.string(),
      message_id: z.string(),
      emoji: z.string(),
    }, safe(async ({ channel_id, message_id, emoji }: { channel_id: string; message_id: string; emoji: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}`)
    ))

    server.tool('message_reaction_clear', 'Remove all reactions from a message (optionally just one emoji)', {
      channel_id: z.string(),
      message_id: z.string(),
      emoji: z.string().optional(),
    }, safe(async ({ channel_id, message_id, emoji }: { channel_id: string; message_id: string; emoji?: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/reactions${emoji ? `/${encodeURIComponent(emoji)}` : ''}`, { method: 'DELETE' })
    ))

    server.tool('message_pin', 'Pin a message', {
      channel_id: z.string(),
      message_id: z.string(),
    }, safe(async ({ channel_id, message_id }: { channel_id: string; message_id: string }) =>
      discordBot(`/channels/${channel_id}/pins/${message_id}`, { method: 'PUT' })))

    server.tool('message_unpin', 'Unpin a message', {
      channel_id: z.string(),
      message_id: z.string(),
    }, safe(async ({ channel_id, message_id }: { channel_id: string; message_id: string }) =>
      discordBot(`/channels/${channel_id}/pins/${message_id}`, { method: 'DELETE' })))

    server.tool('message_pins_list', 'List pinned messages in a channel', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) => discordBot(`/channels/${channel_id}/pins`)))

    server.tool('message_crosspost', 'Publish (crosspost) a message in an announcement channel', {
      channel_id: z.string(),
      message_id: z.string(),
    }, safe(async ({ channel_id, message_id }: { channel_id: string; message_id: string }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/crosspost`, { method: 'POST' })))

    /* ===================== THREADS ===================== */

    server.tool('thread_create', 'Create a new thread in a channel (standalone or a forum post)', {
      channel_id: z.string(),
      name: z.string().min(1).max(100),
      type: z.enum(['public', 'private', 'announcement']).optional().default('public'),
      auto_archive_duration: z.number().int().optional(),
      rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
      message: z.object({ content: z.string().optional(), embeds: z.array(z.record(z.unknown())).optional() }).optional()
        .describe('For forum channels: the initial post content'),
    }, safe(async ({ channel_id, name, type, auto_archive_duration, rate_limit_per_user, message }:
      { channel_id: string; name: string; type?: 'public' | 'private' | 'announcement'; auto_archive_duration?: number; rate_limit_per_user?: number; message?: Record<string, unknown> }) => {
      const typeMap = { public: 11, private: 12, announcement: 10 }
      const body: Record<string, unknown> = { name }
      if (auto_archive_duration !== undefined) body.auto_archive_duration = auto_archive_duration
      if (rate_limit_per_user !== undefined) body.rate_limit_per_user = rate_limit_per_user
      if (message) {
        body.message = message
      } else {
        body.type = typeMap[type ?? 'public']
      }
      return discordBot(`/channels/${channel_id}/threads`, { method: 'POST', body: JSON.stringify(body) })
    }))

    server.tool('thread_create_from_message', 'Create a thread attached to an existing message', {
      channel_id: z.string(),
      message_id: z.string(),
      name: z.string().min(1).max(100),
      auto_archive_duration: z.number().int().optional(),
    }, safe(async ({ channel_id, message_id, name, auto_archive_duration }:
      { channel_id: string; message_id: string; name: string; auto_archive_duration?: number }) =>
      discordBot(`/channels/${channel_id}/messages/${message_id}/threads`, {
        method: 'POST',
        body: JSON.stringify({ name, ...(auto_archive_duration ? { auto_archive_duration } : {}) }),
      })
    ))

    server.tool('thread_edit', 'Edit a thread (name, archived, locked, slowmode)', {
      thread_id: z.string(),
      name: z.string().optional(),
      archived: z.boolean().optional(),
      locked: z.boolean().optional(),
      rate_limit_per_user: z.number().int().min(0).max(21600).optional(),
      auto_archive_duration: z.number().int().optional(),
    }, safe(async ({ thread_id, ...rest }: { thread_id: string; [k: string]: unknown }) =>
      discordBot(`/channels/${thread_id}`, { method: 'PATCH', body: JSON.stringify(rest) })
    ))

    server.tool('thread_join', 'Make the bot join a thread', {
      thread_id: z.string(),
    }, safe(async ({ thread_id }: { thread_id: string }) =>
      discordBot(`/channels/${thread_id}/thread-members/@me`, { method: 'PUT' })))

    server.tool('thread_leave', 'Make the bot leave a thread', {
      thread_id: z.string(),
    }, safe(async ({ thread_id }: { thread_id: string }) =>
      discordBot(`/channels/${thread_id}/thread-members/@me`, { method: 'DELETE' })))

    server.tool('thread_member_add', 'Add a member to a thread', {
      thread_id: z.string(),
      user_id: z.string(),
    }, safe(async ({ thread_id, user_id }: { thread_id: string; user_id: string }) =>
      discordBot(`/channels/${thread_id}/thread-members/${user_id}`, { method: 'PUT' })))

    server.tool('thread_member_remove', 'Remove a member from a thread', {
      thread_id: z.string(),
      user_id: z.string(),
    }, safe(async ({ thread_id, user_id }: { thread_id: string; user_id: string }) =>
      discordBot(`/channels/${thread_id}/thread-members/${user_id}`, { method: 'DELETE' })))

    server.tool('thread_members_list', 'List members of a thread', {
      thread_id: z.string(),
    }, safe(async ({ thread_id }: { thread_id: string }) => discordBot(`/channels/${thread_id}/thread-members?with_member=true`)))

    server.tool('thread_list_active', 'List all active threads in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/threads/active`)))

    server.tool('thread_list_archived_public', 'List archived public threads in a channel', {
      channel_id: z.string(),
      before: z.string().optional(),
      limit: z.number().int().optional(),
    }, safe(async ({ channel_id, before, limit }: { channel_id: string; before?: string; limit?: number }) => {
      const params = new URLSearchParams()
      if (before) params.set('before', before)
      if (limit) params.set('limit', String(limit))
      const qs = params.toString()
      return discordBot(`/channels/${channel_id}/threads/archived/public${qs ? `?${qs}` : ''}`)
    }))

    server.tool('thread_list_archived_private', 'List archived private threads in a channel', {
      channel_id: z.string(),
      before: z.string().optional(),
      limit: z.number().int().optional(),
    }, safe(async ({ channel_id, before, limit }: { channel_id: string; before?: string; limit?: number }) => {
      const params = new URLSearchParams()
      if (before) params.set('before', before)
      if (limit) params.set('limit', String(limit))
      const qs = params.toString()
      return discordBot(`/channels/${channel_id}/threads/archived/private${qs ? `?${qs}` : ''}`)
    }))

    /* ===================== WEBHOOKS ===================== */

    server.tool('webhook_list_channel', 'List webhooks for a channel', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) => discordBot(`/channels/${channel_id}/webhooks`)))

    server.tool('webhook_list_guild', 'List all webhooks in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/webhooks`)))

    server.tool('webhook_get', 'Get a webhook by ID', {
      webhook_id: z.string(),
    }, safe(async ({ webhook_id }: { webhook_id: string }) => discordBot(`/webhooks/${webhook_id}`)))

    server.tool('webhook_create', 'Create a webhook on a channel', {
      channel_id: z.string(),
      name: z.string().min(1).max(80),
    }, safe(async ({ channel_id, name }: { channel_id: string; name: string }) =>
      discordBot(`/channels/${channel_id}/webhooks`, { method: 'POST', body: JSON.stringify({ name }) })))

    server.tool('webhook_edit', 'Edit a webhook (name, channel)', {
      webhook_id: z.string(),
      name: z.string().optional(),
      channel_id: z.string().optional(),
    }, safe(async ({ webhook_id, ...rest }: { webhook_id: string; [k: string]: unknown }) =>
      discordBot(`/webhooks/${webhook_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('webhook_delete', 'Delete a webhook', {
      webhook_id: z.string(),
    }, safe(async ({ webhook_id }: { webhook_id: string }) => discordBot(`/webhooks/${webhook_id}`, { method: 'DELETE' })))

    server.tool('webhook_execute', 'Execute a webhook to send a message (requires webhook token)', {
      webhook_id: z.string(),
      webhook_token: z.string(),
      content: z.string().max(2000).optional(),
      username: z.string().optional(),
      avatar_url: z.string().optional(),
      embeds: z.array(z.record(z.unknown())).optional(),
    }, safe(async ({ webhook_id, webhook_token, ...rest }: { webhook_id: string; webhook_token: string; [k: string]: unknown }) =>
      discordBot(`/webhooks/${webhook_id}/${webhook_token}?wait=true`, { method: 'POST', body: JSON.stringify(rest) })))

    server.tool('webhook_message_get', 'Get a message previously sent by a webhook', {
      webhook_id: z.string(),
      webhook_token: z.string(),
      message_id: z.string(),
    }, safe(async ({ webhook_id, webhook_token, message_id }: { webhook_id: string; webhook_token: string; message_id: string }) =>
      discordBot(`/webhooks/${webhook_id}/${webhook_token}/messages/${message_id}`)))

    server.tool('webhook_message_edit', 'Edit a message previously sent by a webhook', {
      webhook_id: z.string(),
      webhook_token: z.string(),
      message_id: z.string(),
      content: z.string().max(2000).optional(),
      embeds: z.array(z.record(z.unknown())).optional(),
    }, safe(async ({ webhook_id, webhook_token, message_id, ...rest }: { webhook_id: string; webhook_token: string; message_id: string; [k: string]: unknown }) =>
      discordBot(`/webhooks/${webhook_id}/${webhook_token}/messages/${message_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('webhook_message_delete', 'Delete a message previously sent by a webhook', {
      webhook_id: z.string(),
      webhook_token: z.string(),
      message_id: z.string(),
    }, safe(async ({ webhook_id, webhook_token, message_id }: { webhook_id: string; webhook_token: string; message_id: string }) =>
      discordBot(`/webhooks/${webhook_id}/${webhook_token}/messages/${message_id}`, { method: 'DELETE' })))

    /* ===================== INVITES ===================== */

    server.tool('invite_create', 'Create an invite for a channel', {
      channel_id: z.string(),
      max_age: z.number().int().min(0).optional().describe('Seconds, 0 = never expires'),
      max_uses: z.number().int().min(0).max(100).optional(),
      temporary: z.boolean().optional(),
      unique: z.boolean().optional(),
    }, safe(async ({ channel_id, ...rest }: { channel_id: string; [k: string]: unknown }) =>
      discordBot(`/channels/${channel_id}/invites`, { method: 'POST', body: JSON.stringify(rest) })))

    server.tool('invite_list', 'List all invites for the server', {},
      safe(async () => discordBot(`/guilds/${g()}/invites`)))

    server.tool('invite_get', 'Get details on an invite code', {
      invite_code: z.string(),
    }, safe(async ({ invite_code }: { invite_code: string }) =>
      discordBot(`/invites/${invite_code}?with_counts=true`)))

    server.tool('invite_delete', 'Revoke an invite', {
      invite_code: z.string(),
    }, safe(async ({ invite_code }: { invite_code: string }) =>
      discordBot(`/invites/${invite_code}`, { method: 'DELETE' })))

    /* ===================== EMOJIS & STICKERS (EXPRESSIONS) ===================== */

    server.tool('emoji_list', 'List custom emojis in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/emojis`)))

    server.tool('emoji_create', 'Create a custom emoji from base64 image data', {
      name: z.string().min(2).max(32),
      image_base64: z.string().describe('Base64-encoded image data (PNG/JPG/GIF), no data: prefix'),
      image_content_type: z.enum(['image/png', 'image/jpeg', 'image/gif']).default('image/png'),
      roles: z.array(z.string()).optional(),
    }, safe(async ({ name, image_base64, image_content_type, roles }:
      { name: string; image_base64: string; image_content_type: string; roles?: string[] }) =>
      discordBot(`/guilds/${g()}/emojis`, {
        method: 'POST',
        body: JSON.stringify({ name, image: `data:${image_content_type};base64,${image_base64}`, roles: roles ?? [] }),
      })
    ))

    server.tool('emoji_edit', 'Edit a custom emoji (name, allowed roles)', {
      emoji_id: z.string(),
      name: z.string().optional(),
      roles: z.array(z.string()).optional(),
    }, safe(async ({ emoji_id, ...rest }: { emoji_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/emojis/${emoji_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('emoji_delete', 'Delete a custom emoji', {
      emoji_id: z.string(),
    }, safe(async ({ emoji_id }: { emoji_id: string }) =>
      discordBot(`/guilds/${g()}/emojis/${emoji_id}`, { method: 'DELETE' })))

    server.tool('sticker_list', 'List custom stickers in the server', {},
      safe(async () => discordBot(`/guilds/${g()}/stickers`)))

    server.tool('sticker_create', 'Create a custom sticker (uploads a PNG/APNG/GIF/Lottie file, max 512KB)', {
      name: z.string().min(2).max(30),
      description: z.string().min(2).max(100),
      tags: z.string().max(200).describe('A single related emoji, e.g. "smile"'),
      file_base64: z.string(),
      filename: z.string().default('sticker.png'),
      content_type: z.string().default('image/png'),
    }, safe(async ({ name, description, tags, file_base64, filename, content_type }:
      { name: string; description: string; tags: string; file_base64: string; filename: string; content_type: string }) =>
      discordBotForm(`/guilds/${g()}/stickers`, 'POST', { name, description, tags },
        { base64: file_base64, filename, contentType: content_type })
    ))

    server.tool('sticker_edit', 'Edit a custom sticker', {
      sticker_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      tags: z.string().optional(),
    }, safe(async ({ sticker_id, ...rest }: { sticker_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/stickers/${sticker_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('sticker_delete', 'Delete a custom sticker', {
      sticker_id: z.string(),
    }, safe(async ({ sticker_id }: { sticker_id: string }) =>
      discordBot(`/guilds/${g()}/stickers/${sticker_id}`, { method: 'DELETE' })))

    /* ===================== AUTOMOD ===================== */

    server.tool('automod_list', 'List AutoMod rules', {},
      safe(async () => discordBot(`/guilds/${g()}/auto-moderation/rules`)))

    server.tool('automod_get', 'Get a single AutoMod rule', {
      rule_id: z.string(),
    }, safe(async ({ rule_id }: { rule_id: string }) => discordBot(`/guilds/${g()}/auto-moderation/rules/${rule_id}`)))

    server.tool('automod_create', 'Create an AutoMod rule', {
      name: z.string(),
      event_type: z.number().int().describe('1 = MESSAGE_SEND'),
      trigger_type: z.number().int().describe('1 KEYWORD, 3 SPAM, 4 KEYWORD_PRESET, 5 MENTION_SPAM, 6 MEMBER_PROFILE'),
      trigger_metadata: z.record(z.unknown()).optional(),
      actions: z.array(z.record(z.unknown())).min(1),
      enabled: z.boolean().optional(),
      exempt_roles: z.array(z.string()).optional(),
      exempt_channels: z.array(z.string()).optional(),
    }, safe(async (body: Record<string, unknown>) =>
      discordBot(`/guilds/${g()}/auto-moderation/rules`, { method: 'POST', body: JSON.stringify(body) })))

    server.tool('automod_edit', 'Edit an AutoMod rule', {
      rule_id: z.string(),
      name: z.string().optional(),
      event_type: z.number().int().optional(),
      trigger_metadata: z.record(z.unknown()).optional(),
      actions: z.array(z.record(z.unknown())).optional(),
      enabled: z.boolean().optional(),
      exempt_roles: z.array(z.string()).optional(),
      exempt_channels: z.array(z.string()).optional(),
    }, safe(async ({ rule_id, ...rest }: { rule_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/auto-moderation/rules/${rule_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('automod_delete', 'Delete an AutoMod rule', {
      rule_id: z.string(),
    }, safe(async ({ rule_id }: { rule_id: string }) =>
      discordBot(`/guilds/${g()}/auto-moderation/rules/${rule_id}`, { method: 'DELETE' })))

    /* ===================== SCHEDULED EVENTS ===================== */

    server.tool('event_list', 'List scheduled events', {},
      safe(async () => discordBot(`/guilds/${g()}/scheduled-events?with_user_count=true`)))

    server.tool('event_get', 'Get a scheduled event', {
      event_id: z.string(),
    }, safe(async ({ event_id }: { event_id: string }) =>
      discordBot(`/guilds/${g()}/scheduled-events/${event_id}?with_user_count=true`)))

    server.tool('event_create', 'Create a scheduled event. Requires MANAGE_EVENTS (or CREATE_EVENTS on newer API versions).', {
      name: z.string(),
      description: z.string().optional(),
      scheduled_start_time: z.string().describe('ISO8601 timestamp'),
      scheduled_end_time: z.string().optional(),
      privacy_level: z.number().int().default(2).describe('2 = GUILD_ONLY (only supported value)'),
      entity_type: z.number().int().describe('1 STAGE_INSTANCE, 2 VOICE, 3 EXTERNAL'),
      channel_id: z.string().optional().describe('Required for STAGE_INSTANCE / VOICE'),
      entity_metadata: z.object({ location: z.string().optional() }).optional().describe('Required (location) for EXTERNAL'),
    }, safe(async (body: Record<string, unknown>) =>
      discordBot(`/guilds/${g()}/scheduled-events`, { method: 'POST', body: JSON.stringify(body) })))

    server.tool('event_edit', 'Edit a scheduled event (also used to start/end/cancel it via status)', {
      event_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      scheduled_start_time: z.string().optional(),
      scheduled_end_time: z.string().optional(),
      status: z.number().int().optional().describe('1 SCHEDULED, 2 ACTIVE, 3 COMPLETED, 4 CANCELED'),
      channel_id: z.string().nullable().optional(),
      entity_metadata: z.object({ location: z.string().optional() }).optional(),
    }, safe(async ({ event_id, ...rest }: { event_id: string; [k: string]: unknown }) =>
      discordBot(`/guilds/${g()}/scheduled-events/${event_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('event_delete', 'Delete a scheduled event', {
      event_id: z.string(),
    }, safe(async ({ event_id }: { event_id: string }) =>
      discordBot(`/guilds/${g()}/scheduled-events/${event_id}`, { method: 'DELETE' })))

    server.tool('event_users_list', 'List users signed up (interested) for a scheduled event', {
      event_id: z.string(),
      limit: z.number().int().min(1).max(100).optional(),
    }, safe(async ({ event_id, limit }: { event_id: string; limit?: number }) =>
      discordBot(`/guilds/${g()}/scheduled-events/${event_id}/users${limit ? `?limit=${limit}` : ''}`)))

    /* ===================== STAGE INSTANCES ===================== */

    server.tool('stage_create', 'Start a stage instance on a Stage channel', {
      channel_id: z.string(),
      topic: z.string().min(1).max(120),
      privacy_level: z.number().int().optional().describe('1 PUBLIC (deprecated), 2 GUILD_ONLY'),
      send_start_notification: z.boolean().optional(),
    }, safe(async (body: Record<string, unknown>) =>
      discordBot(`/stage-instances`, { method: 'POST', body: JSON.stringify(body) })))

    server.tool('stage_get', 'Get the live stage instance for a Stage channel', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) => discordBot(`/stage-instances/${channel_id}`)))

    server.tool('stage_edit', 'Edit a stage instance topic or privacy level', {
      channel_id: z.string(),
      topic: z.string().optional(),
      privacy_level: z.number().int().optional(),
    }, safe(async ({ channel_id, ...rest }: { channel_id: string; [k: string]: unknown }) =>
      discordBot(`/stage-instances/${channel_id}`, { method: 'PATCH', body: JSON.stringify(rest) })))

    server.tool('stage_delete', 'End a stage instance', {
      channel_id: z.string(),
    }, safe(async ({ channel_id }: { channel_id: string }) =>
      discordBot(`/stage-instances/${channel_id}`, { method: 'DELETE' })))

    /* ===================== ADVANCED / ESCAPE HATCH ===================== */

    server.tool(
      'discord_api',
      `Advanced Discord server management tool. Use this only when no dedicated tool covers the operation you need.

Executes a raw Discord API v10 request using the configured bot token. path must be a relative
path (do not include https://discord.com/api/v10). Only paths under the configured guild,
plus /channels/, /webhooks/, /invites/, and /users/@me, are allowed.

Examples:
GET /guilds/{guild_id}/premium... , GET /guilds/{guild_id}/templates
GET /guilds/{guild_id}/voice-states/@me (limited support)
Use the correct Discord API endpoint and JSON body for the requested operation.`,
      {
        method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
        path: z.string().min(1).describe('Discord API v10 relative path'),
        body: z.record(z.unknown()).optional().describe('JSON request body'),
        query: z.record(z.string()).optional().describe('Query parameters'),
      },
      async ({ method, path, body, query }: { method: string; path: string; body?: Record<string, unknown>; query?: Record<string, string> }) => {
        const guildId = g()

        if (!path.startsWith('/')) return errorResult('Path must start with /')
        if (path.startsWith('//')) return errorResult('Invalid Discord API path')

        const allowed =
          path.startsWith(`/guilds/${guildId}`) ||
          path.startsWith('/channels/') ||
          path.startsWith('/webhooks/') ||
          path.startsWith('/invites/') ||
          path.startsWith('/stage-instances') ||
          path.startsWith('/users/@me')

        if (!allowed) {
          return errorResult(
            `Path not allowed. Allowed prefixes: /guilds/${guildId}, /channels/, /webhooks/, /invites/, /stage-instances, /users/@me`
          )
        }

        let finalPath = path
        if (query && Object.keys(query).length > 0) {
          const params = new URLSearchParams()
          for (const [key, value] of Object.entries(query)) params.set(key, value)
          finalPath += `?${params.toString()}`
        }

        const options: RequestInit = { method }
        if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
          options.body = JSON.stringify(body)
        }

        try {
          return result(await discordBot(finalPath, options))
        } catch (err) {
          return errorResult(redactSecrets(err instanceof Error ? err.message : String(err)))
        }
      }
    )
  },
  {},
  { basePath: '/', maxDuration: 60, verboseLogs: true }
)

/* =========================================================
   MCP AUTH
========================================================= */

app.all('/mcp/*', async (c) => {
  const auth = c.req.header('Authorization')

  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json(
      { error: 'unauthorized', message: 'OAuth authentication required' },
      401,
      { 'WWW-Authenticate': 'Bearer realm="Discord MCP"' }
    )
  }

  const token = auth.slice(7)

  if (!(await verifyOAuthToken(token))) {
    return c.json({ error: 'invalid_token' }, 401, { 'WWW-Authenticate': 'Bearer realm="Discord MCP"' })
  }

  return handler(c.req.raw)
})

/* =========================================================
   OAuth Metadata
========================================================= */

app.get('/.well-known/oauth-protected-resource', (c) => {
  const base = getBaseUrl(c.req.raw)
  return c.json({ resource: `${base}/mcp`, authorization_servers: [base] })
})

app.get('/.well-known/oauth-authorization-server', (c) => {
  const base = getBaseUrl(c.req.raw)
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  })
})

/* =========================================================
   HOME
========================================================= */

app.get('/', (c) => {
  return c.json({
    message: 'Discord Management MCP Server',
    endpoint: '/mcp',
    oauth: { authorize: '/oauth/authorize', token: '/oauth/token', callback: '/oauth/callback' },
    tools: [
      'guild_get', 'guild_edit', 'guild_audit_log', 'guild_vanity_url', 'guild_widget_get', 'guild_widget_edit',
      'guild_onboarding_get', 'guild_integrations_list',
      'channel_list', 'channel_get', 'channel_create', 'channel_edit', 'channel_delete', 'channel_reorder',
      'channel_permissions_get', 'channel_permission_set', 'channel_permission_delete',
      'role_list', 'role_create', 'role_edit', 'role_delete', 'role_reorder',
      'member_role_add', 'member_role_remove',
      'member_list', 'member_search', 'member_get', 'member_edit', 'member_timeout', 'member_timeout_remove',
      'member_kick', 'member_ban', 'member_unban', 'member_ban_list', 'member_bulk_ban',
      'message_list', 'message_get', 'message_send', 'message_edit', 'message_delete', 'message_bulk_delete',
      'message_reaction_add', 'message_reaction_remove', 'message_reaction_list', 'message_reaction_clear',
      'message_pin', 'message_unpin', 'message_pins_list', 'message_crosspost',
      'thread_create', 'thread_create_from_message', 'thread_edit', 'thread_join', 'thread_leave',
      'thread_member_add', 'thread_member_remove', 'thread_members_list', 'thread_list_active',
      'thread_list_archived_public', 'thread_list_archived_private',
      'webhook_list_channel', 'webhook_list_guild', 'webhook_get', 'webhook_create', 'webhook_edit',
      'webhook_delete', 'webhook_execute', 'webhook_message_get', 'webhook_message_edit', 'webhook_message_delete',
      'invite_create', 'invite_list', 'invite_get', 'invite_delete',
      'emoji_list', 'emoji_create', 'emoji_edit', 'emoji_delete',
      'sticker_list', 'sticker_create', 'sticker_edit', 'sticker_delete',
      'automod_list', 'automod_get', 'automod_create', 'automod_edit', 'automod_delete',
      'event_list', 'event_get', 'event_create', 'event_edit', 'event_delete', 'event_users_list',
      'stage_create', 'stage_get', 'stage_edit', 'stage_delete',
      'discord_api',
    ],
  })
})

export default app

