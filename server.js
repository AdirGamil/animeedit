/***********************************************
 * server.js - using Mongoose instead of JSON
 ***********************************************/
import dotenv from 'dotenv'
dotenv.config() // טוען את משתני הסביבה מקובץ .env

import express from 'express'
import path from 'path'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import mongoose from 'mongoose'

// 1) הגדרת __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 2) קריאת משתנה סביבה למחרוזת חיבור MongoDB
const MONGODB_URI = process.env.MONGODB_URI
if (!MONGODB_URI) {
  console.error('ERROR: MONGODB_URI is not defined in environment variables!')
  // אפשר לעצור את התהליך, למשל:
  // process.exit(1)
}

// 3) התחברות ל-MongoDB, עם dbName = 'anime_db'
mongoose
  .connect(MONGODB_URI, {
    dbName: 'anime_db', // מוודא שאנחנו משתמשים בבסיס הנתונים anime_db
  })
  .then(() => console.log('Connected to MongoDB Atlas!'))
  .catch((err) => console.error('MongoDB connection error:', err.message))

// 4) הכנות ל-Express + Socket.IO
const app = express()
app.use(express.json())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' },
})

// 5) In-memory arrays (Locks + PendingEdits)
//    (אפשר להעביר למסד נתונים, אם תרצה)
let locks = []
let pendingEdits = []

// 6) הגדרת סכמות (Schemas) ו-Models
const { Schema, model } = mongoose

// סכמה בסיסית (animeSchema) - משתתפת בכל 3 הקולקשנים
const animeSchema = new Schema(
  {
    anizone_id: Number,
    title: String,
    title_english: String,
    title_hebrew: String,
    synopsis: String,
    synopsis_hebrew: String,
    background: String,
    background_hebrew: String,
    // ... שדות נוספים כרצונך
  },
  { versionKey: false }
)

// בכל קולקציה משתמשים באותה סכמה, אבל Models שונים
const AnimeData = model('AnimeData', animeSchema, 'data') // קולקציית data
const NeedCheckData = model('NeedCheckData', animeSchema, 'needCheck') // קולקציית needCheck
const ApprovedData = model('ApprovedData', animeSchema, 'approved') // קולקציית approved

// 7) Admin credentials
const ADMIN_USER = 'ad123admin'
const ADMIN_PASS = 'ad123admin!'

// 8) API Endpoints

/**
 * (א) מחזיר את האנימות מקולקציית data
 */
app.get('/api/anime', async (req, res) => {
  try {
    const data = await AnimeData.find().lean()
    // מוסיף lock info
    const result = data.map((animeDoc) => {
      const lock = locks.find((l) => l.anizone_id === animeDoc.anizone_id)
      return lock
        ? { ...animeDoc, locked: true, lockedBy: lock.lockedBy }
        : { ...animeDoc, locked: false, lockedBy: null }
    })
    return res.json(result)
  } catch (err) {
    console.error('Error fetching anime from DB:', err.message)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * (ב) משתמש נועל אנימה
 */
app.post('/api/lock/:animeId', (req, res) => {
  const { user } = req.body
  const animeId = parseInt(req.params.animeId, 10)

  // כבר נעול?
  const existingLock = locks.find((l) => l.anizone_id === animeId)
  if (existingLock) {
    return res
      .status(409)
      .json({ error: 'Anime is already locked by someone else' })
  }

  // למשתמש כבר יש נעילה?
  const lockByUser = locks.find((l) => l.lockedBy === user)
  if (lockByUser) {
    return res
      .status(409)
      .json({ error: 'You already locked another anime. Please unlock first.' })
  }

  // מוסיפים נעילה
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })
  io.emit('locksUpdated', locks)
  return res.sendStatus(200)
})

/**
 * (ג) משתמש שומר עריכה -> מוציא מה-collection data => needCheck
 */
app.post('/api/pending-edits', async (req, res) => {
  try {
    const { anizone_id, user, newData } = req.body
    const editId = Date.now().toString()

    // מאתרים אנימה בקולקציית data
    const animeDoc = await AnimeData.findOne({ anizone_id })
    if (!animeDoc) {
      return res
        .status(404)
        .json({ error: 'Anime not found in data collection' })
    }

    // מוחקים מקולקציית data
    await AnimeData.deleteOne({ anizone_id })

    // ממזגים
    const merged = {
      ...animeDoc.toObject(),
      ...newData,
    }

    // מוסיפים ל-needCheck
    await NeedCheckData.create(merged)

    // מעדכנים pendingEdits in-memory
    pendingEdits.push({
      editId,
      anizone_id,
      editedBy: user,
      createdAt: new Date().toISOString(),
      newData,
    })
    io.emit('pendingEditsUpdated', pendingEdits)

    return res.json({ editId })
  } catch (err) {
    console.error('Error in pending-edits:', err.message)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * (ד) GET /api/pending-edits (אדמין רואה עריכות בהמתנה)
 */
app.get('/api/pending-edits', (req, res) => {
  return res.json(pendingEdits)
})

/**
 * (ה) אדמין מאשר עריכה => needCheck => approved
 */
app.post('/api/pending-edits/:editId/approve', async (req, res) => {
  try {
    const { editId } = req.params
    const updatedByAdmin = req.body.newData || {}

    // איתור in-memory
    const idx = pendingEdits.findIndex((p) => p.editId === editId)
    if (idx === -1) {
      return res.status(404).json({ error: 'Pending edit not found' })
    }

    const pend = pendingEdits[idx]
    const animeId = pend.anizone_id

    // איתור האנימה ב-needCheck
    const animeDoc = await NeedCheckData.findOne({ anizone_id: animeId })
    if (!animeDoc) {
      return res
        .status(404)
        .json({ error: 'Anime not found in needCheck collection' })
    }

    // מחיקה מ-needCheck
    await NeedCheckData.deleteOne({ anizone_id: animeId })

    // ממזגים
    const finalData = {
      ...animeDoc.toObject(),
      ...pend.newData,
      ...updatedByAdmin,
    }

    // מוסיפים ל-Approved
    await ApprovedData.create(finalData)

    // מסירים מה-pendingEdits
    pendingEdits.splice(idx, 1)

    // משחררים נעילה
    locks = locks.filter((l) => l.anizone_id !== animeId)
    io.emit('locksUpdated', locks)
    io.emit('pendingEditsUpdated', pendingEdits)

    return res.json({ success: true, updatedAnime: finalData })
  } catch (err) {
    console.error('Error in approve route:', err.message)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * (ו) אדמין דוחה עריכה => מחזיר ל-data (אם רוצים)
 */
app.post('/api/pending-edits/:editId/reject', async (req, res) => {
  try {
    const { editId } = req.params

    // איתור ב-in-memory
    const idx = pendingEdits.findIndex((p) => p.editId === editId)
    if (idx === -1) {
      return res.status(404).json({ error: 'Pending edit not found' })
    }

    const pend = pendingEdits[idx]
    const animeId = pend.anizone_id

    // מוצאים ב-needCheck
    const animeDoc = await NeedCheckData.findOne({ anizone_id: animeId })
    if (animeDoc) {
      // מוחקים מ-needCheck
      await NeedCheckData.deleteOne({ anizone_id: animeId })

      // מחזירים ל-data
      await AnimeData.create(animeDoc.toObject())
    }

    // מסירים מ-pendingEdits
    pendingEdits.splice(idx, 1)

    // משחררים נעילה
    locks = locks.filter((l) => l.anizone_id !== animeId)
    io.emit('locksUpdated', locks)
    io.emit('pendingEditsUpdated', pendingEdits)

    return res.json({ success: true })
  } catch (err) {
    console.error('Error in reject route:', err.message)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * (ז) נקודת קצה להחזרת רשימת הנעילות
 */
app.get('/api/admin/locks', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  return res.json(locks)
})

/**
 * Force Unlock (אדמין)
 */
app.post('/api/admin/unlock/:animeId', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  const animeId = parseInt(req.params.animeId, 10)
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  return res.json({ success: true })
})

/**
 * (ח) Unlock למשתמש
 */
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = parseInt(req.params.animeId, 10)
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  return res.sendStatus(200)
})

/**
 * לוגין אדמין
 */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: 'dummy-admin-token' })
  }
  return res.status(401).json({ error: 'Invalid credentials' })
})

/**
 * רשימת ה-Pending לאדמין
 */
app.get('/api/admin/pending-edits', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  return res.json(pendingEdits)
})

/**
 * סטטיסטיקות (DB)
 */
app.get('/api/admin/stats', async (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  try {
    const dataCount = await AnimeData.countDocuments()
    const needCount = await NeedCheckData.countDocuments()
    const approvedCount = await ApprovedData.countDocuments()

    const totalPending = pendingEdits.length
    const totalData = dataCount
    const totalApproved = approvedCount
    // אם תרצה לספור גם needCheck => let totalOverall = dataCount + needCount
    const totalOverall = dataCount

    return res.json({
      totalData,
      totalApproved,
      totalPending,
      totalOverall,
    })
  } catch (err) {
    console.error('Error in stats route:', err.message)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
})

/**
 * הגשת קבצי הלקוח (React build)
 */
app.use(express.static(path.join(__dirname, 'client/build')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'))
})

/**
 * Socket.IO
 */
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || 'unknown'
  console.log('A user connected:', socket.id, '-> userId:', userId)

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id, '-> userId:', userId)
    locks = locks.filter((l) => l.lockedBy !== userId)
    io.emit('locksUpdated', locks)
  })
})

// הרצת השרת
const PORT = process.env.PORT || 3030
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
