import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const LEADERBOARD_KEY = 'leaderboard:global'

const parseBody = (body) => {
  if (body && typeof body === 'object') {
    return body
  }

  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return null
    }
  }

  return null
}

const cleanName = (value) => {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim().slice(0, 12)
  return trimmed.length > 0 ? trimmed : null
}

const cleanScore = (value) => {
  if (typeof value !== 'number') {
    return null
  }
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return null
  }
  if (value < 0 || value > 999999) {
    return null
  }
  return value
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const body = parseBody(req.body)
  if (!body) {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const name = cleanName(body.name)
  const score = cleanScore(body.score)

  if (!name) {
    return res.status(400).json({ error: 'Invalid name' })
  }

  if (score === null) {
    return res.status(400).json({ error: 'Invalid score' })
  }

  const member = `${name}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`

  try {
    await redis.zadd(LEADERBOARD_KEY, { score, member })

    const size = await redis.zcard(LEADERBOARD_KEY)
    if (size > 200) {
      await redis.zremrangebyrank(LEADERBOARD_KEY, 0, size - 201)
    }

    return res.status(200).json({ ok: true })
  } catch {
    return res.status(500).json({ error: 'Failed to submit score' })
  }
}