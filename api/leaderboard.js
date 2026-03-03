import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const LEADERBOARD_KEY = 'leaderboard:global'

const parseEntries = (rows) => {
  if (!Array.isArray(rows)) {
    return []
  }

  if (rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
    return rows
      .map((row) => {
        const member = typeof row.member === 'string' ? row.member : ''
        const score = Number(row.score)
        const name = member.split(':')[0]?.trim() ?? ''
        if (!name || !Number.isFinite(score)) {
          return null
        }
        return { name, score: Math.trunc(score) }
      })
      .filter(Boolean)
  }

  const entries = []
  for (let i = 0; i < rows.length; i += 2) {
    const member = rows[i]
    const scoreRaw = rows[i + 1]
    if (typeof member !== 'string') {
      continue
    }
    const score = Number(scoreRaw)
    const name = member.split(':')[0]?.trim() ?? ''
    if (!name || !Number.isFinite(score)) {
      continue
    }
    entries.push({ name, score: Math.trunc(score) })
  }
  return entries
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  try {
    const rows = await redis.zrange(LEADERBOARD_KEY, 0, 2, {
      rev: true,
      withScores: true,
    })

    const entries = parseEntries(rows).slice(0, 3)

    return res.status(200).json({ entries })
  } catch {
    return res.status(500).json({ error: 'Failed to load leaderboard' })
  }
}
