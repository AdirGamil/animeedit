/***********************************************
 * server.js - using Mongoose instead of JSON
 ***********************************************/
import express from 'express'
import path from 'path'
import fs from 'fs'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import mongoose from 'mongoose'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json())

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' },
})

// -----------------------------------------------------
// 1) הגדרת משתנה סביבה למחרוזת חיבור
// -----------------------------------------------------
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb+srv://adminov:adminov@animeedit.domgo.mongodb.net/?retryWrites=true&w=majority&appName=animeedit'

// -----------------------------------------------------
// 2) חיבור ל-MongoDB
// -----------------------------------------------------
mongoose
  .connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log('Connected to MongoDB Atlas!')
  })
  .catch((err) => {
    console.error('Error connecting to MongoDB Atlas:', err.message)
  })

// -----------------------------------------------------
// 3) In-memory arrays (אם רוצים להשאיר)
//    או אפשר להעביר גם אותם למסד (בעיקר locks & pendingEdits)
// -----------------------------------------------------
let locks = []
let pendingEdits = []

// -----------------------------------------------------
// 4) הגדרת סכמות (Schemas) ו-Models
// -----------------------------------------------------
import mongoose from 'mongoose'
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
    // ועוד שדות שתרצה
  },
  { versionKey: false }
)

// בכל קולקציה נשתמש באותה סכמה, אבל Models שונים
const AnimeData = model('AnimeData', animeSchema, 'data') // קולקציה data
const NeedCheckData = model('NeedCheckData', animeSchema, 'needCheck') // קולקציה needCheck
const ApprovedData = model('ApprovedData', animeSchema, 'approved') // קולקציה approved

// -----------------------------------------------------
// 5) Admin credentials
// -----------------------------------------------------
const ADMIN_USER = 'ad123admin'
const ADMIN_PASS = 'ad123admin!'

// -----------------------------------------------------
// 6) API Endpoints
// -----------------------------------------------------

/**
 * (א) מחזיר את האנימות שעדיין בקולקציית `data`
 */
app.get('/api/anime', async (req, res) => {
  try {
    // נטען את האנימות מ-DB
    const data = await AnimeData.find().lean()
    // מוסיפים lock info
    const result = data.map((animeDoc) => {
      const lock = locks.find((l) => l.anizone_id === animeDoc.anizone_id)
      if (lock) {
        return { ...animeDoc, locked: true, lockedBy: lock.lockedBy }
      }
      return { ...animeDoc, locked: false, lockedBy: null }
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

  // בדיקה אם כבר נעול
  const existingLock = locks.find((l) => l.anizone_id === animeId)
  if (existingLock) {
    return res
      .status(409)
      .json({ error: 'Anime is already locked by someone else' })
  }

  // בדיקה אם למשתמש כבר יש נעילה
  const existingByUser = locks.find((l) => l.lockedBy === user)
  if (existingByUser) {
    return res.status(409).json({
      error: 'You already locked another anime. Please unlock first.',
    })
  }

  // מוסיפים
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })
  io.emit('locksUpdated', locks)
  return res.sendStatus(200)
})

/**
 * (ג) משתמש שומר עריכה -> מוציאים את האנימה מ-collection data ומוסיפים ל-collection needCheck
 */
app.post('/api/pending-edits', async (req, res) => {
  try {
    const { anizone_id, user, newData } = req.body
    const editId = Date.now().toString()

    // 1) מאתרים אנימה בקולקציית data
    const animeDoc = await AnimeData.findOne({ anizone_id })
    if (!animeDoc) {
      return res
        .status(404)
        .json({ error: 'Anime not found in data collection' })
    }

    // 2) מסירים מקולקציית data
    await AnimeData.deleteOne({ anizone_id })

    // 3) ממזגים
    const merged = {
      ...animeDoc.toObject(),
      ...newData,
    }

    // 4) מוסיפים לקולקציית needCheck
    await NeedCheckData.create(merged)

    // 5) מוסיפים ל-pendingEdits in-memory
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
 * (ד) GET /api/pending-edits  - אדמין רואה עריכות בהמתנה
 */
app.get('/api/pending-edits', (req, res) => {
  return res.json(pendingEdits)
})

/**
 * (ה) אדמין מאשר עריכה -> מוציא מ-needCheckData.json (עכשיו = קולקציית NeedCheck) -> לקולקציית Approved
 */
app.post('/api/pending-edits/:editId/approve', async (req, res) => {
  try {
    const { editId } = req.params
    const updatedByAdmin = req.body.newData || {}

    // 1) איתור העריכה ב-pendingEdits
    const idx = pendingEdits.findIndex((p) => p.editId === editId)
    if (idx === -1) {
      return res.status(404).json({ error: 'Pending edit not found' })
    }

    const pend = pendingEdits[idx]
    const animeId = pend.anizone_id

    // 2) איתור האנימה בקולקציית NeedCheck
    const animeDoc = await NeedCheckData.findOne({ anizone_id: animeId })
    if (!animeDoc) {
      return res
        .status(404)
        .json({ error: 'Anime not found in needCheck collection' })
    }

    // 3) מחיקה מקולקציית needCheck
    await NeedCheckData.deleteOne({ anizone_id: animeId })

    // 4) ממזגים
    const finalData = {
      ...animeDoc.toObject(),
      ...pend.newData,
      ...updatedByAdmin,
    }

    // 5) מוסיפים ל-Approved
    await ApprovedData.create(finalData)

    // 6) מסירים מ-pendingEdits
    pendingEdits.splice(idx, 1)

    // 7) משחררים נעילה
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
 * (ו) אדמין דוחה עריכה -> מחזיר האנימה ל-data או פשוט מסיר
 */
app.post('/api/pending-edits/:editId/reject', async (req, res) => {
  try {
    const { editId } = req.params

    // 1) איתור העריכה ב-in-memory
    const idx = pendingEdits.findIndex((p) => p.editId === editId)
    if (idx === -1) {
      return res.status(404).json({ error: 'Pending edit not found' })
    }

    const pend = pendingEdits[idx]
    const animeId = pend.anizone_id

    // 2) מחפשים את האנימה בקולקציית needCheck
    const animeDoc = await NeedCheckData.findOne({ anizone_id: animeId })
    if (animeDoc) {
      // מוחקים מ-needCheck
      await NeedCheckData.deleteOne({ anizone_id: animeId })

      // אם רוצים להחזיר ל-data
      await AnimeData.create(animeDoc.toObject())
    }

    // 3) מסירים מ-pendingEdits
    pendingEdits.splice(idx, 1)

    // 4) משחררים נעילה
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
 * Force Unlock
 */
app.post('/api/admin/unlock/:animeId', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  const animeId = +req.params.animeId
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  return res.json({ success: true })
})

/**
 * (ח) Unlock למשתמש
 */
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = +req.params.animeId
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
 * סטטיסטיקות - סופרות רשומות ב-DB
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

    // כאן pendingEdits זה in-memory
    const totalPending = pendingEdits.length

    // החלטנו ש"totalOverall" זה מספר האנימות ב-data
    const totalData = dataCount
    const totalApproved = approvedCount
    const totalOverall = dataCount // או dataCount + needCount ?

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
 * הגשת קבצי הלקוח
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
    // אופציונלי: הסרה מ locks
    locks = locks.filter((l) => l.lockedBy !== userId)
    io.emit('locksUpdated', locks)
  })
})

// הרצת השרת
const PORT = process.env.PORT || 3030
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
