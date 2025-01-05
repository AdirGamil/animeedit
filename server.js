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

// --------------------------------
// 1) In-memory data
// --------------------------------
let locks = [] // [{ anizone_id, lockedBy, lockedAt }]
let pendingEdits = [] // [{ editId, anizone_id, editedBy, newData }]

// --------------------------------
// 2) Admin credentials
// --------------------------------
const ADMIN_USER = 'ad123admin'
const ADMIN_PASS = 'ad123admin!'

// --------------------------------
// 3) JSON Paths
// --------------------------------
const dataPath = path.join(__dirname, 'public', 'data.json')
const needCheckPath = path.join(__dirname, 'public', 'needCheckData.json')
const approvedPath = path.join(__dirname, 'public', 'approvedData.json')

// --------------------------------
// 4) Ensure files exist
//    (If a file doesn't exist, create an empty JSON array)
// --------------------------------
const defaultFiles = [dataPath, needCheckPath, approvedPath]
defaultFiles.forEach((filePath) => {
  if (!fs.existsSync(filePath)) {
    console.warn(`Creating default file: ${filePath}`)
    fs.writeFileSync(filePath, JSON.stringify([]))
  }
})

// Debug logs
console.log('==== JSON PATHS ====')
console.log(`dataPath:       ${dataPath}`)
console.log(`needCheckPath:  ${needCheckPath}`)
console.log(`approvedPath:   ${approvedPath}`)
console.log('====================')

// --------------------------------
// 5) Helper functions for load/save
// --------------------------------
function loadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}. Creating new empty file.`)
      fs.writeFileSync(filePath, JSON.stringify([]))
      return []
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    console.error(`Error reading file at ${filePath}:`, err.message)
    return []
  }
}

function saveFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error(`Error saving file at ${filePath}:`, err.message)
  }
}

// **Load** wrappers
function loadData() {
  return loadFile(dataPath)
}
function loadNeedCheck() {
  return loadFile(needCheckPath)
}
function loadApproved() {
  return loadFile(approvedPath)
}

// **Save** wrappers
function saveData(arr) {
  saveFile(dataPath, arr)
}
function saveNeedCheck(arr) {
  saveFile(needCheckPath, arr)
}
function saveApproved(arr) {
  saveFile(approvedPath, arr)
}

// --------------------------------
// 6) API Endpoints
// --------------------------------

/**
 * (א) מחזיר את האנימות שעדיין ב-data.json
 * (needCheckData.json לא מוצג למשתמש רגיל)
 */
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

  // בדיקה אם למשתמש זה כבר יש נעילה
  const existingByUser = locks.find((l) => l.lockedBy === user)
  if (existingByUser) {
    return res
      .status(409)
      .json({ error: 'You already locked another anime. Please unlock first.' })
  }

  // מוסיפים לרשימת הנעילות
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })
  io.emit('locksUpdated', locks)
  res.sendStatus(200)
})

/**
 * (ג) משתמש שומר עריכה -> מוציאים את האנימה מ-data.json ומוסיפים ל-needCheckData.json
 */
app.post('/api/pending-edits', (req, res) => {
  const { anizone_id, user, newData } = req.body
  const editId = Date.now().toString()

  // 1) מוציאים מה-data.json
  const dataArr = loadData()
  const idx = dataArr.findIndex((a) => a.anizone_id === anizone_id)
  if (idx === -1) {
    return res.status(404).json({ error: 'Anime not found in data.json' })
  }

  const animeObj = dataArr[idx]
  dataArr.splice(idx, 1)
  saveData(dataArr)

  // 2) ממזגים newData
  const merged = { ...animeObj, ...newData }

  // 3) מוסיפים ל-needCheckData.json
  const needCheckArr = loadNeedCheck()
  needCheckArr.push(merged)
  saveNeedCheck(needCheckArr)

  // 4) שומרים ב-pendingEdits in-memory
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

/**
 * (ד) GET /api/pending-edits - אדמין רואה עריכות בהמתנה
 */
app.get('/api/pending-edits', (req, res) => {
  res.json(pendingEdits)
})

/**
 * (ה) אדמין מאשר עריכה -> מוציא מ-needCheckData.json ומוסיף ל-approvedData.json
 */
app.post('/api/pending-edits/:editId/approve', (req, res) => {
  const { editId } = req.params
  const updatedByAdmin = req.body.newData || {}

  // 1) חיפוש ב-pendingEdits in-memory
  const idx = pendingEdits.findIndex((p) => p.editId === editId)
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pend = pendingEdits[idx]
  const animeId = pend.anizone_id

  // 2) מוצאים את האנימה ב-needCheckData.json
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

  // 3) מסירים מ-needCheck
  needArr.splice(needIdx, 1)
  saveNeedCheck(needArr)

  // 4) מוסיפים ל-approvedData.json
  const approvedArr = loadApproved()
  approvedArr.push(finalData)
  saveApproved(approvedArr)

  // 5) מסירים מה-pendingEdits in-memory
  pendingEdits.splice(idx, 1)

  // 6) משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true, updatedAnime: finalData })
})

/**
 * (ו) אדמין דוחה עריכה -> מסיר מ-needCheckData.json ומחזיר ל-data.json אם רוצים
 */
app.post('/api/pending-edits/:editId/reject', (req, res) => {
  const { editId } = req.params

  const idx = pendingEdits.findIndex((p) => p.editId === editId)
  if (idx === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pend = pendingEdits[idx]
  const animeId = pend.anizone_id

  // מוצאים את האנימה ב-needCheckData.json
  const needArr = loadNeedCheck()
  const needIdx = needArr.findIndex((a) => a.anizone_id === animeId)
  if (needIdx !== -1) {
    const animeObj = needArr[needIdx]
    // מסירים
    needArr.splice(needIdx, 1)
    saveNeedCheck(needArr)

    // מחזירים ל-data.json אם רוצים
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

/**
 * (ז) נקודת קצה להחזרת רשימת הנעילות (admin)
 */
app.get('/api/admin/locks', (req, res) => {
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }
  res.json(locks)
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
  res.json({ success: true })
})

/**
 * (ח) Unlock למשתמש
 */
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = +req.params.animeId
  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)
  res.sendStatus(200)
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
  res.json(pendingEdits)
})

/**
 * סטטיסטיקות
 */
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
    // אם תרצה: הסרת נעילות של אותו userId
    locks = locks.filter((l) => l.lockedBy !== userId)
    io.emit('locksUpdated', locks)
  })
})

// הרצת השרת
const PORT = process.env.PORT || 3030
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
