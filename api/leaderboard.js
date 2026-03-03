import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const LEADERBOARD_KEY = 'leaderboard:global'

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

    const entries = rows.map((row) => {
      const member = typeof row?.member === 'string' ? row.member : ''
      const name = member.split(':')[0] || 'PLAYER'
      const score = Number(row?.score)
      return {
        name,
        score: Number.isFinite(score) ? Math.trunc(score) : 0,
      }
    })

    return res.status(200).json({ entries })
  } catch {
    return res.status(500).json({ error: 'Failed to load leaderboard' })
  }
}