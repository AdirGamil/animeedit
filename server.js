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

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: '*' },
})

// In-memory (נעילות + פנדינג אינפורמציה)
let locks = [] // [{ anizone_id, lockedBy, lockedAt }]
let pendingEdits = [] // [{ editId, anizone_id, editedBy, newData }]

// אדמין
const ADMIN_USER = 'ad123admin'
const ADMIN_PASS = 'ad123admin!'

// 3 קבצי JSON
const dataPath = path.join(__dirname, 'public', 'data.json')
const needCheckPath = path.join(__dirname, 'public', 'needCheckData.json')
const approvedPath = path.join(__dirname, 'public', 'approvedData.json')

function loadData() {
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8'))
}
function saveData(arr) {
  fs.writeFileSync(dataPath, JSON.stringify(arr, null, 2))
}

function loadNeedCheck() {
  return JSON.parse(fs.readFileSync(needCheckPath, 'utf-8'))
}
function saveNeedCheck(arr) {
  fs.writeFileSync(needCheckPath, JSON.stringify(arr, null, 2))
}

function loadApproved() {
  return JSON.parse(fs.readFileSync(approvedPath, 'utf-8'))
}
function saveApproved(arr) {
  fs.writeFileSync(approvedPath, JSON.stringify(arr, null, 2))
}

// --------------------------------
// API
// --------------------------------

// (א) מחזיר את האנימות שעדיין ב-data.json
// (needCheckData.json לא מוצג למשתמש רגיל)
app.get('/api/anime', (req, res) => {
  const data = loadData()
  // משדכים lock info
  const result = data.map((anime) => {
    const lock = locks.find((l) => l.anizone_id === anime.anizone_id)
    if (lock) {
      return { ...anime, locked: true, lockedBy: lock.lockedBy }
    }
    return { ...anime, locked: false, lockedBy: null }
  })
  res.json(result)
})

// (ב) משתמש נועל אנימה
app.post('/api/lock/:animeId', (req, res) => {
  const { user } = req.body
  const animeId = +req.params.animeId

  // בדיקה אם האנימה כבר נעולה
  const existingLock = locks.find((l) => l.anizone_id === animeId)
  if (existingLock) {
    return res
      .status(409)
      .json({ error: 'Anime is already locked by someone else' })
  }

  // בדיקה אם למשתמש כבר יש אנימה נעולה
  const existingByUser = locks.find((l) => l.lockedBy === user)
  if (existingByUser) {
    return res.status(409).json({
      error: 'You already locked another anime. Please unlock first.',
    })
  }

  // מוסיפים ל-locks
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })
  io.emit('locksUpdated', locks)
  res.sendStatus(200)
})

// (ג) משתמש שומר עריכה -> מוציאים את האנימה מ-data.json ומוסיפים ל-needCheckData.json
app.post('/api/pending-edits', (req, res) => {
  const { anizone_id, user, newData } = req.body
  const editId = Date.now().toString()

  // מוציאים מ-data.json
  const dataArr = loadData()
  const idx = dataArr.findIndex((a) => a.anizone_id === anizone_id)
  if (idx === -1) {
    return res.status(404).json({ error: 'Anime not found in data.json' })
  }
  // מוציאים את האובייקט
  const animeObj = dataArr[idx]
  dataArr.splice(idx, 1)
  saveData(dataArr)

  // ממזגים newData
  const merged = { ...animeObj, ...newData }
  // מוסיפים ל-needCheckData.json
  const needCheckArr = loadNeedCheck()
  needCheckArr.push(merged)
  saveNeedCheck(needCheckArr)

  // in-memory pendingEdits (אופציונלי, לתצוגה באדמין)
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

// (ד) GET /api/pending-edits  - אדמין רואה עריכות בהמתנה
app.get('/api/pending-edits', (req, res) => {
  res.json(pendingEdits)
})

// (ה) אדמין מאשר עריכה -> מוציא מ-needCheckData.json ומוסיף ל-approvedData.json
app.post('/api/pending-edits/:editId/approve', (req, res) => {
  const { editId } = req.params
  const updatedByAdmin = req.body.newData || {}

  // חיפוש ב-pendingEdits in-memory
  const idx = pendingEdits.findIndex((p) => p.editId === editId)
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pend = pendingEdits[idx]
  const animeId = pend.anizone_id

  // מוצאים את האנימה ב-needCheckData.json
  const needArr = loadNeedCheck()
  const needIdx = needArr.findIndex((a) => a.anizone_id === animeId)
  if (needIdx === -1) {
    return res
      .status(404)
      .json({ error: 'Anime not found in needCheckData.json' })
  }

  const animeObj = needArr[needIdx]
  // ממזגים
  const finalData = { ...animeObj, ...pend.newData, ...updatedByAdmin }

  // מסירים מ-needCheck
  needArr.splice(needIdx, 1)
  saveNeedCheck(needArr)

  // מוסיפים ל-approvedData.json
  const approvedArr = loadApproved()
  approvedArr.push(finalData)
  saveApprovedData(approvedArr)

  // מסירים מה-pendingEdits
  pendingEdits.splice(idx, 1)

  // משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true, updatedAnime: finalData })
})

// (ו) אדמין דוחה עריכה -> מחזיר האנימה ל-data.json או פשוט מסיר מ-needCheck
app.post('/api/pending-edits/:editId/reject', (req, res) => {
  const { editId } = req.params

  const idx = pendingEdits.findIndex((p) => p.editId === editId)
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pend = pendingEdits[idx]
  const animeId = pend.anizone_id

  // נרצה אולי להחזיר האנימה ל-data.json (אם הדחייה אומרת שהיא חוזרת לזמינה)
  // או פשוט להסיר מ-needCheck.
  const needArr = loadNeedCheck()
  const needIdx = needArr.findIndex((a) => a.anizone_id === animeId)
  if (needIdx !== -1) {
    // מחזירים את האנימה ל-data.json אם תרצה
    // כרגע בוא נניח שמוחקים מ-needCheckData.json
    const animeObj = needArr[needIdx]
    needArr.splice(needIdx, 1)
    saveNeedCheck(needArr)

    // החזרת האנימה ל-data.json
    const dataArr = loadData()
    dataArr.push(animeObj)
    saveData(dataArr)
  }

  // מסירים מ-pendingEdits
  pendingEdits.splice(idx, 1)

  // משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true })
})

// (ז) נקודת קצה להחזרת רשימת הנעילות
app.get('/api/admin/locks', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  res.json(locks)
})

// Force Unlock
app.post('/api/admin/unlock/:animeId', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  const animeId = +req.params.animeId
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  res.json({ success: true })
})

// (ח) Unlock למשתמש
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = +req.params.animeId
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  res.sendStatus(200)
})

// לוגין אדמין
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: 'dummy-admin-token' })
  }
  return res.status(401).json({ error: 'Invalid credentials' })
})

// רשימת ה-Pending לאדמין
app.get('/api/admin/pending-edits', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  res.json(pendingEdits)
})

// סטטיסטיקות
app.get('/api/admin/stats', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }

  const dataArr = loadData()
  const needArr = loadNeedCheck()
  const approvedArr = loadApproved()

  const totalPending = pendingEdits.length
  const totalData = dataArr.length
  const totalApproved = approvedArr.length
  const totalOverall = totalData

  res.json({
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

// Socket.IO event listeners
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || 'unknown'
  console.log('A user connected:', socket.id, '-> userId:', userId)

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id, '-> userId:', userId)
    // אם תרצה כאן להסיר גם את נעילות של המשתמש =>
    locks = locks.filter((l) => l.lockedBy !== userId)
    io.emit('locksUpdated', locks)
  })
})

// הרצת השרת
const PORT = process.env.PORT || 3030
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
