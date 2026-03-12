import Phaser from 'phaser'
import { Analytics } from "@vercel/analytics/react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import './App.css'

type LeaderboardEntry = {
  name: string
  score: number
}

type ActiveScreen = 'about' | 'projects' | 'contact' | null
type ObstacleOverlayState = {
  id: number
  x: number
  y: number
  width: number
  height: number
}

type RunnerObstacle = {
  id: number
  lane: number
  x: number
  y: number
  width: number
  height: number
  active: boolean
}

const LEADERBOARD_ENDPOINT = '/api/leaderboard'
const SUBMIT_SCORE_ENDPOINT = '/api/submit'
const GAME_WIDTH = 320
const GAME_HEIGHT = 568
const PROJECT_ITEMS = [
  { href: 'https://www.instagram.com/p/DSkDZ8sjEf7/', src: '/ig/1.mp4', type: 'video' as const },
  { href: 'https://www.instagram.com/p/DR2H6MrjIvp/', src: '/ig/2.png', type: 'image' as const },
  { href: 'https://www.instagram.com/p/DTuuWWYDFmv/', src: '/ig/3.mp4', type: 'video' as const },
  { href: 'https://www.instagram.com/p/DRr2ijTDOjJ/', src: '/ig/4.mp4', type: 'video' as const },
  { href: 'https://www.instagram.com/p/DSPQSRaDP5G/', src: '/ig/5.mp4', type: 'video' as const },
  { href: 'https://www.instagram.com/p/DSCULJ6DP8O/', src: '/ig/6.mp4', type: 'video' as const },
]

const normalizeLeaderboard = (entries: unknown): LeaderboardEntry[] => {
  if (!Array.isArray(entries)) {
    return []
  }

  return entries
    .filter(
      (entry): entry is LeaderboardEntry =>
        typeof entry?.name === 'string' && typeof entry?.score === 'number',
    )
    .map((entry) => ({
      name: entry.name.trim().slice(0, 12),
      score: Math.max(0, Math.min(999999, Math.trunc(entry.score))),
    }))
    .filter((entry) => entry.name.length > 0)
    .filter((entry) => !(entry.name === 'PLAYER' && entry.score === 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
}

const fetchLeaderboard = async () => {
  const response = await fetch(LEADERBOARD_ENDPOINT)
  if (!response.ok) {
    throw new Error('Failed leaderboard fetch')
  }
  const payload = (await response.json()) as { entries?: unknown }
  return normalizeLeaderboard(payload.entries)
}

const submitScore = async (name: string, score: number) => {
  const response = await fetch(SUBMIT_SCORE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, score }),
  })

  if (!response.ok) {
    throw new Error('Failed score submit')
  }
}

class RunnerScene extends Phaser.Scene {
  private readonly laneCount = 4
  private laneIndex = 1
  private laneCenters: number[] = []
  private horizonY = 130
  private roadTopWidth = 90
  private roadBottomWidth = 290
  private roadCenterX = 160
  private obstacleAspectRatio = 1

  private player!: Phaser.GameObjects.Image
  private roadGraphics!: Phaser.GameObjects.Graphics
  private obstacles: RunnerObstacle[] = []
  private nextObstacleId = 1
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys
  private cloudA!: Phaser.GameObjects.Image
  private cloudB!: Phaser.GameObjects.Image
  private skyLineTop!: Phaser.GameObjects.Image
  private skyLineBottom!: Phaser.GameObjects.Image

  private pointerDragging = false
  private speed = 280
  private spawnAccumulator = 0
  private score = 0
  private crashed = false
  private roadScroll = 0
  private hasStarted = false
  private readonly onScore: (score: number) => void
  private readonly onCrash: (score: number) => void
  private readonly onObstacles: (obstacles: ObstacleOverlayState[]) => void

  constructor(
    onScore: (score: number) => void,
    onCrash: (score: number) => void,
    onObstacles: (obstacles: ObstacleOverlayState[]) => void,
  ) {
    super('runner-scene')
    this.onScore = onScore
    this.onCrash = onCrash
    this.onObstacles = onObstacles
  }

  preload() {
    this.load.image('obstacle-png', '/obstacle.png')
  }

  create() {
    this.cameras.main.setBackgroundColor('#ffffff')

    this.createTextures()
    const obstacleSource = this.textures.get('obstacle-png').getSourceImage() as {
      width?: number
      height?: number
    }
    if (obstacleSource.width && obstacleSource.height && obstacleSource.width > 0) {
      this.obstacleAspectRatio = obstacleSource.height / obstacleSource.width
    }

    this.roadGraphics = this.add.graphics()

    this.player = this.add.image(0, 0, 'runner-car').setDisplaySize(52, 76)
    this.player.setDepth(10)
    this.cloudA = this.add.image(72, 54, 'runner-cloud').setDepth(1)
    this.cloudB = this.add.image(245, 74, 'runner-cloud').setDepth(1).setScale(0.9)
    this.createSkyWriting()

    this.cursors = this.input.keyboard?.createCursorKeys()
    this.input.on('pointerdown', this.handlePointerDown, this)
    this.input.on('pointermove', this.handlePointerMove, this)
    this.input.on('pointerup', this.handlePointerUp, this)
    this.input.on('pointerupoutside', this.handlePointerUp, this)

    this.scale.on('resize', this.handleResize, this)
    this.handleResize(this.scale.gameSize)
    this.publishObstacles()
    this.scene.pause()
  }

  update(_: number, delta: number) {
    if (this.crashed) {
      return
    }
    if (!this.hasStarted) {
      return
    }

    const dt = delta / 1000
    this.speed += dt * 8
    this.score += dt * (this.speed * 0.105)
    this.roadScroll += this.speed * dt
    this.onScore(Math.floor(this.score))
    this.drawScene()

    if (this.cursors?.left && Phaser.Input.Keyboard.JustDown(this.cursors.left)) {
      this.changeLane(this.laneIndex - 1)
    }
    if (this.cursors?.right && Phaser.Input.Keyboard.JustDown(this.cursors.right)) {
      this.changeLane(this.laneIndex + 1)
    }

    this.spawnAccumulator += delta
    const spawnInterval = Math.max(260, 860 - this.speed * 1.2)

    if (this.spawnAccumulator >= spawnInterval) {
      this.spawnAccumulator = 0
      this.spawnObstacle()
    }

    const playerLane = this.getPlayerLaneForCollision()
    const playerHitbox = this.getPlayerHitbox()
    const gameHeight = this.scale.height

    this.obstacles.forEach((obstacle) => {
      if (!obstacle.active) {
        return
      }

      const perspective = Phaser.Math.Clamp(
        (obstacle.y - this.horizonY) / (this.scale.height - this.horizonY),
        0,
        1,
      )
      obstacle.y += this.speed * dt * (0.45 + perspective * 1.35)
      obstacle.x = this.getLaneX(obstacle.lane, obstacle.y)
      const size = this.getObstacleDisplaySize(obstacle.y)
      obstacle.width = size.width
      obstacle.height = size.height

      if (obstacle.y > gameHeight + 80) {
        obstacle.active = false
        return
      }

      if (obstacle.lane !== playerLane) {
        return
      }

      const obstacleHitbox = this.getObstacleHitbox(obstacle)
      if (Phaser.Geom.Intersects.RectangleToRectangle(playerHitbox, obstacleHitbox)) {
        this.handleCrash()
      }
    })
    this.obstacles = this.obstacles.filter((obstacle) => obstacle.active)
    this.publishObstacles()
  }

  pauseGame() {
    if (!this.crashed && this.hasStarted) {
      this.scene.pause()
    }
  }

  resumeGame() {
    if (!this.crashed && this.hasStarted) {
      this.scene.resume()
    }
  }

  startRun() {
    if (this.hasStarted) {
      return
    }
    this.hasStarted = true
    this.scene.resume()
  }

  restartGame() {
    this.obstacles = []
    this.nextObstacleId = 1
    this.crashed = false
    this.speed = 280
    this.spawnAccumulator = 0
    this.score = 0
    this.roadScroll = 0
    this.laneIndex = 1
    this.snapPlayerToLane()
    this.onScore(0)
    this.drawScene()
    this.publishObstacles()
    this.scene.resume()
  }

  private handleCrash() {
    if (this.crashed) {
      return
    }
    this.crashed = true
    this.onCrash(Math.floor(this.score))
    this.scene.pause()
  }

  private spawnObstacle() {
    if (this.laneCenters.length === 0) {
      return
    }
    const lane = Phaser.Math.Between(0, this.laneCount - 1)
    const spawnY = this.horizonY + Phaser.Math.Between(20, 40)
    const x = this.laneCenters[lane]
    const size = this.getObstacleDisplaySize(spawnY)
    this.obstacles.push({
      id: this.nextObstacleId,
      lane,
      x,
      y: spawnY,
      width: size.width,
      height: size.height,
      active: true,
    })
    this.nextObstacleId += 1
  }

  private changeLane(nextLane: number) {
    const clamped = Phaser.Math.Clamp(nextLane, 0, this.laneCount - 1)
    if (clamped === this.laneIndex) {
      return
    }
    this.laneIndex = clamped
    this.tweens.add({
      targets: this.player,
      x: this.laneCenters[this.laneIndex],
      duration: 90,
      ease: 'Sine.Out',
    })
  }

  private snapPointerToLane(pointerX: number) {
    if (this.laneCenters.length === 0) {
      return
    }

    let closest = 0
    let closestDistance = Math.abs(pointerX - this.laneCenters[0])

    for (let i = 1; i < this.laneCenters.length; i += 1) {
      const distance = Math.abs(pointerX - this.laneCenters[i])
      if (distance < closestDistance) {
        closestDistance = distance
        closest = i
      }
    }

    this.changeLane(closest)
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    this.pointerDragging = true
    this.snapPointerToLane(pointer.x)
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer) {
    if (!this.pointerDragging) {
      return
    }
    this.snapPointerToLane(pointer.x)
  }

  private handlePointerUp() {
    this.pointerDragging = false
  }

  private handleResize(gameSize: Phaser.Structs.Size) {
    const { width, height } = gameSize
    this.roadCenterX = width / 2
    this.horizonY = Math.floor(height * 0.34)
    this.roadTopWidth = Math.max(76, Math.floor(width * 0.24))
    this.roadBottomWidth = Math.max(300, Math.floor(width * 1.25))

    this.laneCenters = Array.from(
      { length: this.laneCount },
      (_, index) => this.getLaneX(index, height - 96),
    )

    this.cloudA.setPosition(width * 0.2, this.horizonY * 0.32)
    this.cloudB.setPosition(width * 0.76, this.horizonY * 0.48)
    this.skyLineTop.setPosition(width * 0.5, this.horizonY * 0.56)
    this.skyLineBottom.setPosition(width * 0.5, this.horizonY * 0.7)

    this.drawScene()
    this.snapPlayerToLane()
  }

  private snapPlayerToLane() {
    if (!this.player || this.laneCenters.length === 0) {
      return
    }
    this.player.x = this.laneCenters[this.laneIndex]
    this.player.y = this.scale.height - 58
  }

  private drawRoad(height: number) {
    const topLeft = this.roadCenterX - this.roadTopWidth / 2
    const topRight = this.roadCenterX + this.roadTopWidth / 2
    const bottomLeft = this.roadCenterX - this.roadBottomWidth / 2
    const bottomRight = this.roadCenterX + this.roadBottomWidth / 2

    this.roadGraphics.clear()
    this.roadGraphics.fillGradientStyle(0x5fa8d3, 0x5fa8d3, 0x4f98c4, 0x4f98c4, 1)
    this.roadGraphics.fillRect(0, 0, this.scale.width, this.horizonY)
    this.drawMountains()

    this.roadGraphics.fillStyle(0x2d6a4f)
    this.roadGraphics.fillRect(0, this.horizonY - 10, this.scale.width, 12)
    for (let x = 0; x < this.scale.width + 8; x += 10) {
      const h = (x % 20 === 0 ? 10 : 7) + ((x / 10) % 3)
      this.roadGraphics.fillRect(x, this.horizonY - h, 8, h)
    }

    this.roadGraphics.fillStyle(0x6cc551)
    this.roadGraphics.fillRect(0, this.horizonY, topLeft, height - this.horizonY)
    this.roadGraphics.fillRect(topRight, this.horizonY, this.scale.width - topRight, height - this.horizonY)

    this.roadGraphics.fillStyle(0x3a3a3a)
    this.roadGraphics.beginPath()
    this.roadGraphics.moveTo(topLeft, this.horizonY)
    this.roadGraphics.lineTo(topRight, this.horizonY)
    this.roadGraphics.lineTo(bottomRight, height)
    this.roadGraphics.lineTo(bottomLeft, height)
    this.roadGraphics.closePath()
    this.roadGraphics.fillPath()

    const stripeStep = 18
    const stripeOffset = Math.floor(this.roadScroll % stripeStep)
    for (let y = this.horizonY + stripeOffset; y < height; y += stripeStep) {
      const left = this.getRoadLeftAt(y)
      const right = this.getRoadRightAt(y)
      const nextY = Math.min(y + stripeStep, height)
      const nextLeft = this.getRoadLeftAt(nextY)
      const nextRight = this.getRoadRightAt(nextY)
      const isRed = Math.floor((y + this.roadScroll) / stripeStep) % 2 === 0
      this.roadGraphics.fillStyle(isRed ? 0xd7263d : 0xf1f1f1)

      this.roadGraphics.beginPath()
      this.roadGraphics.moveTo(left - 8, y)
      this.roadGraphics.lineTo(left, y)
      this.roadGraphics.lineTo(nextLeft, nextY)
      this.roadGraphics.lineTo(nextLeft - 8, nextY)
      this.roadGraphics.closePath()
      this.roadGraphics.fillPath()

      this.roadGraphics.beginPath()
      this.roadGraphics.moveTo(right, y)
      this.roadGraphics.lineTo(right + 8, y)
      this.roadGraphics.lineTo(nextRight + 8, nextY)
      this.roadGraphics.lineTo(nextRight, nextY)
      this.roadGraphics.closePath()
      this.roadGraphics.fillPath()
    }

    const markerStep = 24
    const markerOffset = Math.floor(this.roadScroll % markerStep)
    for (let y = this.horizonY + markerOffset; y < height; y += markerStep) {
      const t = Phaser.Math.Clamp((y - this.horizonY) / (height - this.horizonY), 0, 1)
      const dashHeight = 3 + t * 12
      const laneA = this.getLaneDividerX(1, y)
      const laneB = this.getLaneDividerX(2, y)
      const laneC = this.getLaneDividerX(3, y)
      const mid = this.getLaneX(1.5, y)
      this.roadGraphics.fillStyle(0xf5f5f5)
      this.roadGraphics.fillRect(laneA - 1, y, 2, dashHeight * 0.45)
      this.roadGraphics.fillRect(laneB - 1, y, 2, dashHeight * 0.45)
      this.roadGraphics.fillRect(laneC - 1, y, 2, dashHeight * 0.45)
      this.roadGraphics.fillRect(mid - 2, y, 4, dashHeight)
    }

  }

  private drawScene() {
    this.drawRoad(this.scale.height)
  }

  private drawMountains() {
    const width = this.scale.width
    const baseY = this.horizonY - 2

    this.roadGraphics.fillStyle(0x2a2d6b)
    let x = -32
    while (x < width + 64) {
      const peakW = 44
      const peakH = 24 + ((Math.floor((x + 64) / 44) % 3) * 6)
      this.roadGraphics.beginPath()
      this.roadGraphics.moveTo(x, baseY)
      this.roadGraphics.lineTo(x + peakW / 2, baseY - peakH)
      this.roadGraphics.lineTo(x + peakW, baseY)
      this.roadGraphics.closePath()
      this.roadGraphics.fillPath()
      x += peakW - 8
    }

    this.roadGraphics.fillStyle(0x1f2254)
    x = -24
    while (x < width + 56) {
      const peakW = 36
      const peakH = 16 + ((Math.floor((x + 48) / 36) % 2) * 4)
      this.roadGraphics.beginPath()
      this.roadGraphics.moveTo(x, baseY)
      this.roadGraphics.lineTo(x + peakW / 2, baseY - peakH)
      this.roadGraphics.lineTo(x + peakW, baseY)
      this.roadGraphics.closePath()
      this.roadGraphics.fillPath()
      x += peakW - 6
    }
  }

  private createSkyWriting() {
    this.skyLineTop = this.add.image(160, 70, 'runner-sky-line-top').setDepth(3)
    this.skyLineBottom = this.add.image(160, 92, 'runner-sky-line-bottom').setDepth(3)
  }

  private createPixelTextTexture(textureKey: string, text: string, pixelSize: number) {
    if (this.textures.exists(textureKey)) {
      return
    }

    const glyphs: Record<string, string[]> = {
      A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
      C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
      D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
      E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
      G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
      I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
      L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
      N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
      O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
      R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
      S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
      T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
      U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
      ' ': ['000', '000', '000', '000', '000', '000', '000'],
    }

    const upper = text.toUpperCase()
    const pad = 6
    let widthUnits = 0
    for (let i = 0; i < upper.length; i += 1) {
      const char = upper[i]
      const glyph = glyphs[char] ?? glyphs[' ']
      widthUnits += glyph[0].length + 1
    }
    const unitHeight = 7
    const texWidth = widthUnits * pixelSize + pad * 2
    const texHeight = unitHeight * pixelSize + pad * 2

    const occupancy = new Set<string>()
    let cursorX = 0
    for (let i = 0; i < upper.length; i += 1) {
      const char = upper[i]
      const glyph = glyphs[char] ?? glyphs[' ']
      for (let gy = 0; gy < glyph.length; gy += 1) {
        for (let gx = 0; gx < glyph[gy].length; gx += 1) {
          if (glyph[gy][gx] === '1') {
            occupancy.add(`${cursorX + gx},${gy}`)
          }
        }
      }
      cursorX += glyph[0].length + 1
    }

    const cloud = this.add.graphics({ x: 0, y: 0 })
    cloud.setVisible(false)
    for (const key of occupancy) {
      const [sx, sy] = key.split(',').map(Number)
      cloud.fillStyle(0x2f4f7a, 1)
      cloud.fillRect(pad + (sx + 1) * pixelSize, pad + (sy + 1) * pixelSize, pixelSize, pixelSize)
    }
    for (const key of occupancy) {
      const [sx, sy] = key.split(',').map(Number)
      cloud.fillStyle(0xffffff, 1)
      cloud.fillRect(pad + sx * pixelSize, pad + sy * pixelSize, pixelSize, pixelSize)
    }
    cloud.generateTexture(textureKey, texWidth, texHeight)
    cloud.destroy()
  }

  private getRoadLeftAt(y: number) {
    const t = Phaser.Math.Clamp((y - this.horizonY) / (this.scale.height - this.horizonY), 0, 1)
    const halfWidth = Phaser.Math.Linear(this.roadTopWidth / 2, this.roadBottomWidth / 2, t)
    return this.roadCenterX - halfWidth
  }

  private getRoadRightAt(y: number) {
    const t = Phaser.Math.Clamp((y - this.horizonY) / (this.scale.height - this.horizonY), 0, 1)
    const halfWidth = Phaser.Math.Linear(this.roadTopWidth / 2, this.roadBottomWidth / 2, t)
    return this.roadCenterX + halfWidth
  }

  private getLaneDividerX(divider: number, y: number) {
    const left = this.getRoadLeftAt(y)
    const right = this.getRoadRightAt(y)
    return left + ((right - left) / this.laneCount) * divider
  }

  private getLaneX(lane: number, y: number) {
    const left = this.getRoadLeftAt(y)
    const right = this.getRoadRightAt(y)
    const laneWidth = (right - left) / this.laneCount
    return left + laneWidth * (lane + 0.5)
  }

  private getPlayerLaneForCollision() {
    let closestLane = 0
    let closestDistance = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.laneCenters.length; i += 1) {
      const distance = Math.abs(this.player.x - this.laneCenters[i])
      if (distance < closestDistance) {
        closestDistance = distance
        closestLane = i
      }
    }
    return closestLane
  }

  private getPlayerHitbox() {
    return new Phaser.Geom.Rectangle(this.player.x - 11, this.player.y - 17, 22, 32)
  }

  private getObstacleHitbox(obstacle: RunnerObstacle) {
    const width = obstacle.width * 0.72
    const height = obstacle.height * 0.72
    const yOffset = obstacle.height * 0.06
    return new Phaser.Geom.Rectangle(
      obstacle.x - width / 2,
      obstacle.y - height / 2 + yOffset,
      width,
      height,
    )
  }

  private getObstacleDisplaySize(y: number) {
    const roadWidth = this.getRoadRightAt(y) - this.getRoadLeftAt(y)
    const laneWidth = roadWidth / this.laneCount
    let width = Math.min(laneWidth * 0.92, 170)
    let height = width * this.obstacleAspectRatio
    if (height > 90) {
      const clampScale = 90 / height
      height = 90
      width *= clampScale
    }
    return { width: width * 1.5 * 1.3, height: height * 1.5 * 1.3 }
  }

  private publishObstacles() {
    this.onObstacles(
      this.obstacles
        .filter((obstacle) => obstacle.active)
        .map((obstacle) => ({
          id: obstacle.id,
          x: obstacle.x,
          y: obstacle.y,
          width: obstacle.width,
          height: obstacle.height,
        })),
    )
  }

  private createTextures() {
    this.createPixelTextTexture('runner-sky-line-top', 'LA OLLA STUDIO', 2)
    this.createPixelTextTexture('runner-sky-line-bottom', 'DIGITAL CONTENT', 3)

    if (!this.textures.exists('runner-cloud')) {
      const cloud = this.add.graphics({ x: 0, y: 0 })
      cloud.setVisible(false)
      cloud.fillStyle(0xf8fbff)
      cloud.fillRect(4, 8, 36, 14)
      cloud.fillRect(12, 2, 18, 8)
      cloud.fillRect(28, 4, 16, 10)
      cloud.generateTexture('runner-cloud', 48, 24)
      cloud.destroy()
    }
    if (!this.textures.exists('runner-car')) {
      const car = this.add.graphics({ x: 0, y: 0 })
      car.setVisible(false)
      car.fillStyle(0xd7263d)
      car.fillRect(14, 4, 20, 10)
      car.fillRect(10, 14, 28, 26)
      car.fillRect(8, 40, 32, 24)
      car.fillRect(4, 64, 40, 18)
      car.fillStyle(0x2b2d42)
      car.fillRect(2, 18, 8, 14)
      car.fillRect(38, 18, 8, 14)
      car.fillRect(2, 60, 8, 16)
      car.fillRect(38, 60, 8, 16)
      car.fillStyle(0xffca3a)
      car.fillRect(16, 50, 16, 8)
      car.fillStyle(0x7bdff2)
      car.fillRect(14, 16, 20, 12)
      car.fillRect(16, 30, 16, 10)
      car.fillStyle(0x111111)
      car.fillRect(20, 68, 8, 14)
      car.generateTexture('runner-car', 48, 86)
      car.destroy()
    }

    if (!this.textures.exists('runner-pot')) {
      const pot = this.add.graphics({ x: 0, y: 0 })
      pot.setVisible(false)
      pot.fillStyle(0xc1121f)
      pot.fillRect(12, 12, 32, 6)
      pot.fillRect(10, 18, 36, 22)
      pot.fillStyle(0xe63946)
      pot.fillRect(14, 22, 28, 6)
      pot.fillStyle(0x7f0000)
      pot.fillRect(4, 22, 6, 10)
      pot.fillRect(46, 22, 6, 10)
      pot.fillStyle(0x8b0a16)
      pot.fillRect(16, 40, 24, 4)
      pot.generateTexture('runner-pot', 56, 48)
      pot.destroy()
    }
  }
}

function App() {
  const gameContainerRef = useRef<HTMLDivElement | null>(null)
  const gameRef = useRef<Phaser.Game | null>(null)
  const sceneRef = useRef<RunnerScene | null>(null)

  const [score, setScore] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [gameOver, setGameOver] = useState(false)
  const [hasStarted, setHasStarted] = useState(false)
  const [isTouchDevice, setIsTouchDevice] = useState(false)
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [obstacles, setObstacles] = useState<ObstacleOverlayState[]>([])

  const updateLeaderboard = useCallback(async (finalScore: number) => {
    if (finalScore <= 0) {
      return
    }

    let current: LeaderboardEntry[] = []
    try {
      current = await fetchLeaderboard()
      setLeaderboard(current)
    } catch {
      setLeaderboard([])
      return
    }

    const qualifies =
      current.length < 3 ||
      finalScore > current[current.length - 1].score

    if (!qualifies) {
      return
    }

    const nameInput = window.prompt('Top 3! Enter your name:', 'PLAYER')
    if (nameInput === null) {
      return
    }

    const cleanName = nameInput.trim().slice(0, 12)
    if (!cleanName) {
      return
    }

    try {
      await submitScore(cleanName, finalScore)
      const refreshed = await fetchLeaderboard()
      setLeaderboard(refreshed)
    } catch {
      setLeaderboard([])
    }
  }, [])

  useEffect(() => {
    let mounted = true

    void (async () => {
      try {
        const entries = await fetchLeaderboard()
        if (mounted) {
          setLeaderboard(entries)
        }
      } catch {
        if (mounted) {
          setLeaderboard([])
        }
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const touchCapable =
      typeof window !== 'undefined' &&
      (navigator.maxTouchPoints > 0 ||
        window.matchMedia('(pointer: coarse)').matches ||
        'ontouchstart' in window)
    setIsTouchDevice(touchCapable)
  }, [])

  const startRun = useCallback(() => {
    if (hasStarted || menuOpen || activeScreen || !sceneRef.current) {
      return
    }
    sceneRef.current?.startRun()
    setHasStarted(true)
  }, [hasStarted, menuOpen, activeScreen])

  useEffect(() => {
    if (!gameContainerRef.current || gameRef.current) {
      return
    }

    const scene = new RunnerScene(
      (nextScore) => setScore(nextScore),
      (finalScore) => {
        setScore(finalScore)
        setGameOver(true)
        setMenuOpen(true)
        void updateLeaderboard(finalScore)
      },
      (nextObstacles) => setObstacles(nextObstacles),
    )
    sceneRef.current = scene

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: gameContainerRef.current,
      backgroundColor: '#ffffff',
      pixelArt: true,
      antialias: false,
      scene,
      scale: {
        mode: Phaser.Scale.ENVELOP,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 320,
        height: 568,
      },
    })
    gameRef.current = game

    return () => {
      sceneRef.current = null
      gameRef.current?.destroy(true)
      gameRef.current = null
      setObstacles([])
    }
  }, [updateLeaderboard])

  useEffect(() => {
    if (isTouchDevice || hasStarted) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (menuOpen || activeScreen) {
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        startRun()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isTouchDevice, hasStarted, menuOpen, activeScreen, startRun])

  const openMenu = () => {
    sceneRef.current?.pauseGame()
    setMenuOpen(true)
  }

  const keepPlaying = () => {
    if (gameOver) {
      sceneRef.current?.restartGame()
      setScore(0)
      setGameOver(false)
      setHasStarted(true)
    } else {
      sceneRef.current?.resumeGame()
    }
    setActiveScreen(null)
    setMenuOpen(false)
  }

  const openScreen = (screen: Exclude<ActiveScreen, null>) => {
    sceneRef.current?.pauseGame()
    setMenuOpen(true)
    setActiveScreen(screen)
  }

  const goBackFromScreen = () => {
    setActiveScreen(null)
  }

  const closeMenu = () => {
    if (gameOver || activeScreen) {
      return
    }
    setMenuOpen(false)
    sceneRef.current?.resumeGame()
  }

  const handlePointerStart = (event: PointerEvent<HTMLElement>) => {
    if (!isTouchDevice || hasStarted || menuOpen || activeScreen) {
      return
    }
    const target = event.target as HTMLElement | null
    if (target?.closest('.hud') || target?.closest('.menu-overlay')) {
      return
    }
    startRun()
  }

  return (
    <main className="app-shell" onPointerDown={handlePointerStart}>
      <div ref={gameContainerRef} className="game-canvas" />
      <div className="obstacle-overlay" aria-hidden="true">
        {obstacles.map((obstacle) => (
          <img
            key={obstacle.id}
            src="/obstacle.png"
            alt=""
            className="obstacle-overlay-item"
            style={{
              width: `${(obstacle.width / GAME_WIDTH) * 100}vw`,
              height: `${(obstacle.height / GAME_HEIGHT) * 100}vh`,
              transform: `translate(-50%, -50%) translate(${(obstacle.x / GAME_WIDTH) * 100}vw, ${(obstacle.y / GAME_HEIGHT) * 100}vh)`,
            }}
          />
        ))}
      </div>

      <section className="hud leaderboard">
        <h2>TOP 3</h2>
        <ol>
          {leaderboard.length === 0 ? <li>NO SCORES YET</li> : null}
          {leaderboard.map((entry) => (
            <li key={`${entry.name}-${entry.score}`}>
              <span>{entry.name}</span>
              <span>{entry.score}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="hud status">
        <p>SCORE {score}</p>
        <button type="button" onClick={openMenu} aria-label="Open settings">
          SETTINGS + INFO
        </button>
      </section>

      {menuOpen ? (
        <aside className="menu-overlay" role="dialog" aria-modal="true">
          <div className="menu-card">
            <h1>{gameOver ? 'GAME OVER' : 'PAUSED'}</h1>
            <p>{gameOver ? `FINAL SCORE ${score}` : 'RUNNER PAUSED'}</p>
            <button type="button" onClick={keepPlaying}>
              KEEP PLAYING
            </button>
            <button type="button" onClick={() => openScreen('about')}>
              ABOUT
            </button>
            <button type="button" onClick={() => openScreen('projects')}>
              PROJECTS
            </button>
            <button type="button" onClick={() => openScreen('contact')}>
              CONTACT
            </button>
            <a href="https://www.instagram.com/laolla.studio/" target="_blank" rel="noreferrer">
              INSTAGRAM
            </a>
            {!gameOver ? (
              <button type="button" className="menu-close" onClick={closeMenu}>
                CLOSE
              </button>
            ) : null}
          </div>
        </aside>
      ) : null}

      {activeScreen ? (
        <section className="screen-overlay" role="dialog" aria-modal="true">
          <article className="screen-page">
            <button type="button" className="screen-back" onClick={goBackFromScreen}>
              Go back
            </button>

            {activeScreen === 'about' ? (
              <>
                <h1>About</h1>
                <p>
                  La Olla Studio is a Barcelona-based digital content studio creating social-first visuals
                  for brands, artists and agencies.
                </p>
                <p>
                  Some projects call for fast, reactive content built for social. Others need more
                  crafted visuals for launches, campaigns or key brand moments. We move between
                  both, creating content that feels current, clear and on brand.
                </p>
                <p>
                  From concept to final delivery, we focus on making ideas feel sharp, relevant and
                  easy to connect with.
                </p>
                <h2>Creative Direction</h2>
                <p>
                  We help define the idea, visual approach and overall feel of a project, making
                  sure the content is clear, strong and on brand.
                </p>
                <h2>Organic Content Production</h2>
                <p>
                  We create natural, platform-ready content for social media, from
                  behind-the-scenes coverage and support content on larger shoots to fully led
                  vertical productions for Instagram and TikTok.
                </p>
                <h2>Editing</h2>
                <p>
                  We turn footage into clear, engaging and well-paced content designed to work
                  across social platforms.
                </p>
                <h2>CGI &amp; 3D Animation</h2>
                <p>
                  We create 3D visuals and animations that help brands present products, ideas and
                  campaigns in a more striking and memorable way.
                </p>
                <h2>AI Video &amp; Visuals</h2>
                <p>
                  We use AI as a creative tool to produce original and visually strong content for
                  social media, campaigns and digital projects.
                </p>
              </>
            ) : null}

            {activeScreen === 'projects' ? (
              <>
                <h1>Projects</h1>
                <p>
                  We&apos;ve worked with fashion and lifestyle brands, collaborated with artists, and
                  partnered with agencies across a wide range of projects.
                </p>
                <p>
                  Clients and collaborators: Arpias, Bar Bocara, Bellenuit, Besmaya, Breathdeep,
                  Brownie, Coches by Carla, Dropset, Fabra Comunicación, Facegloss, GN0, Good News,
                  Jabba, Kilite, La Vall, Lady Pipa, Maen Studio, Mainline, MIM, Motel Rocks, Multi
                  Ópticas, Nude Project, Ouineta, Outer Gin, Polarity Services, Rotate, Sita
                  Nevado, Susmie&apos;s, TéPone.
                </p>
                <p>
                  See all of our projects on{' '}
                  <a href="https://www.instagram.com/laolla.studio/" target="_blank" rel="noreferrer">
                    Instagram
                  </a>
                </p>
                <h2>Selected projects</h2>
                <div className="projects-grid">
                  {PROJECT_ITEMS.map((project) => (
                    <a
                      key={project.href}
                      href={project.href}
                      target="_blank"
                      rel="noreferrer"
                      className="project-tile"
                    >
                      {project.type === 'video' ? (
                        <video
                          src={project.src}
                          className="project-media"
                          autoPlay
                          muted
                          loop
                          playsInline
                          preload="metadata"
                        />
                      ) : (
                        <img src={project.src} alt="" className="project-media" />
                      )}
                    </a>
                  ))}
                </div>
              </>
            ) : null}

            {activeScreen === 'contact' ? (
              <>
                <h1>Contact</h1>
                <p>Email: vacf99@gmail.com</p>
                <p>
                  Instagram:{' '}
                  <a href="https://www.instagram.com/laolla.studio/" target="_blank" rel="noreferrer">
                    https://www.instagram.com/laolla.studio/
                  </a>
                </p>
              </>
            ) : null}
          </article>
        </section>
      ) : null}

      {!hasStarted ? (
        <section className="start-overlay" aria-live="polite">
          <div className="start-card">
            <h1>Welcome to La Olla Studio </h1>
            <p>
              {isTouchDevice
                ? 'Tap the screen to start playing'
                : 'Press \u2190 or \u2192 to start playing'}
              <br />
              Or open Settings + Info to learn about the studio.
            </p>
          </div>
        </section>
      ) : null}
     <Analytics />
    </main>
  )
}

export default App
