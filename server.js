import express from 'express'
import path from 'path'
import fs from 'fs'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json())

// 1) יצירת httpServer + Socket.IO
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' },
})

// 2) מבני נתונים In-Memory
let locks = [] // [{ anizone_id, lockedBy, lockedAt }]
let pendingEdits = [] // [{ editId, anizone_id, editedBy, newData }]

// משתמש/סיסמה לאדמין (דוגמה)
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin'

// 3) נתיבים לקבצי JSON
const dataPath = path.join(__dirname, 'data', 'data.json')
const approvedPath = path.join(__dirname, 'data', 'approvedData.json')

function loadAnimeData() {
  const raw = fs.readFileSync(dataPath, 'utf-8')
  return JSON.parse(raw)
}

function saveAnimeData(updatedArray) {
  fs.writeFileSync(dataPath, JSON.stringify(updatedArray, null, 2))
}

function loadApprovedData() {
  const raw = fs.readFileSync(approvedPath, 'utf-8')
  return JSON.parse(raw)
}

function saveApprovedData(updatedArray) {
  fs.writeFileSync(approvedPath, JSON.stringify(updatedArray, null, 2))
}

// 4) API Routes

// (א) מחזיר את רשימת האנימות
app.get('/api/anime', (req, res) => {
  const allAnime = loadAnimeData()
  const result = allAnime.map((anime) => {
    const foundLock = locks.find((l) => l.anizone_id === anime.anizone_id)
    if (foundLock) {
      return {
        ...anime,
        locked: true,
        lockedBy: foundLock.lockedBy, // מי נעל
      }
    } else {
      return {
        ...anime,
        locked: false,
        lockedBy: null,
      }
    }
  })
  res.json(result)
})

// (ב) נעילה
app.post('/api/lock/:animeId', (req, res) => {
  const { user } = req.body // שם המשתמש הנועל
  const animeId = parseInt(req.params.animeId, 10)

  // בדיקה אם יש כבר נעילה
  const existingLock = locks.find((l) => l.anizone_id === animeId)
  if (existingLock) {
    // כבר נעול בידי אחר
    return res
      .status(409)
      .json({ error: 'Anime is already locked by someone else' })
  }

  // אם לא נעול, נועל
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })

  io.emit('locksUpdated', locks) // לשדר לכל המחוברים
  res.sendStatus(200)
})

// (ג) שמירת עריכה בהמתנה
app.post('/api/pending-edits', (req, res) => {
  const { anizone_id, user, newData } = req.body
  const editId = Date.now().toString()

  pendingEdits.push({
    editId,
    anizone_id,
    editedBy: user,
    createdAt: new Date().toISOString(),
    newData,
  })

  io.emit('pendingEditsUpdated', pendingEdits)
  res.json({ editId })
})

// (ד) נקודת GET לכל העריכות בהמתנה (אדמין)
app.get('/api/pending-edits', (req, res) => {
  res.json(pendingEdits)
})

// (ה) אישור עריכה
app.post('/api/pending-edits/:editId/approve', (req, res) => {
  const { editId } = req.params
  const updatedByAdmin = req.body.newData || {}

  const editIndex = pendingEdits.findIndex((p) => p.editId === editId)
  if (editIndex === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pendingEdit = pendingEdits[editIndex]
  const animeId = pendingEdit.anizone_id

  // טוען האנימות
  const oldAnimeList = loadAnimeData()
  const animeIndex = oldAnimeList.findIndex((a) => a.anizone_id === animeId)
  if (animeIndex === -1) {
    return res.status(404).json({ error: 'Anime not found in data.json' })
  }

  // ממזגים
  const finalData = {
    ...oldAnimeList[animeIndex],
    ...pendingEdit.newData,
    ...updatedByAdmin,
  }

  // מסירים מ-data
  oldAnimeList.splice(animeIndex, 1)
  saveAnimeData(oldAnimeList)

  // מוסיפים ל-approved
  const approvedList = loadApprovedData()
  approvedList.push(finalData)
  saveApprovedData(approvedList)

  // מסירים מה-pendingEdits
  pendingEdits.splice(editIndex, 1)

  // משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)

  // משדרים
  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true, updatedAnime: finalData })
})

// (ו) דחיית עריכה
app.post('/api/pending-edits/:editId/reject', (req, res) => {
  const { editId } = req.params
  const editIndex = pendingEdits.findIndex((p) => p.editId === editId)
  if (editIndex === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const animeId = pendingEdits[editIndex].anizone_id

  pendingEdits.splice(editIndex, 1)
  // משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)

  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true })
})

// (ז) שחרור נעילה
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = parseInt(req.params.animeId, 10)
  // מסנן החוצה את הנעילה לאנימה הזו
  locks = locks.filter((l) => l.anizone_id !== animeId)

  io.emit('locksUpdated', locks)
  res.sendStatus(200)
})

// 5) לוגין אדמין
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: 'dummy-admin-token' })
  }
  return res.status(401).json({ error: 'Invalid credentials' })
})

// 6) רשימת ה-Pending לאדמין
app.get('/api/admin/pending-edits', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  return res.json(pendingEdits)
})

// סטטיסטיקות
app.get('/api/admin/stats', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }

  const dataJson = loadAnimeData()
  const approvedJson = loadApprovedData()
  const totalPending = pendingEdits.length

  const totalData = dataJson.length
  const totalApproved = approvedJson.length
  const totalOverall = totalData

  return res.json({
    totalData,
    totalApproved,
    totalPending,
    totalOverall,
  })
})

// הגשת קבצי הלקוח
app.use(express.static(path.join(__dirname, 'client/build')))
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'))
})

// 8) הפעלת השרת
const PORT = process.env.PORT || 3030
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
