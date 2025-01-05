import express from 'express'
import path from 'path'
import fs from 'fs'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

// --------------------------------
// 1) WebSocket Server (Socket.IO)
// --------------------------------
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
})

// --------------------------------
// 2) "In-Memory" data
// --------------------------------
let locks = [] // { anizone_id, lockedBy, lockedAt }
let pendingEdits = [] // { editId, anizone_id, editedBy, newData, ... }

// משתמש/סיסמה לאדמין (לדוגמה)
const ADMIN_USER = 'admin'
const ADMIN_PASS = 'admin'

// --------------------------------
// 3) נתיבים לקבצי JSON
// --------------------------------
const dataPath = path.join(process.cwd(), 'public', 'data.json')
const approvedPath = path.join(process.cwd(), 'public', 'approvedData.json')

function loadAnimeData() {
  const raw = fs.readFileSync(dataPath, 'utf-8')
  return JSON.parse(raw) // מערך אנימות "ישנות"
}

function saveAnimeData(updatedArray) {
  fs.writeFileSync(dataPath, JSON.stringify(updatedArray, null, 2))
}

function loadApprovedData() {
  const raw = fs.readFileSync(approvedPath, 'utf-8')
  return JSON.parse(raw) // מערך אנימות "מאושרות"
}

function saveApprovedData(updatedArray) {
  fs.writeFileSync(approvedPath, JSON.stringify(updatedArray, null, 2))
}

// --------------------------------
// 4) API Routes
// --------------------------------

/**
 * (א) מחזיר את רשימת האנימות מ-data.json
 * כשהן לא הועברו עדיין ל-approved
 * הוספנו שדות locked ו-lockedBy לפי הנעילות בשרת
 */
app.get('/api/anime', (req, res) => {
  const allAnime = loadAnimeData() // רק מהקובץ ה"ישן"
  const result = allAnime.map((anime) => {
    const foundLock = locks.find((lock) => lock.anizone_id === anime.anizone_id)
    if (foundLock) {
      return {
        ...anime,
        locked: true,
        lockedBy: foundLock.lockedBy,
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

/**
 * (ב) נעילה (Lock)
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

  // אם לא נעול -> נועלים
  locks.push({
    anizone_id: animeId,
    lockedBy: user,
    lockedAt: new Date().toISOString(),
  })

  io.emit('locksUpdated', locks) // עדכון לכל המחוברים
  res.sendStatus(200)
})

/**
 * (ג) שמירת עריכה בהמתנה (Pending)
 */
app.post('/api/pending-edits', (req, res) => {
  const { anizone_id, user, newData } = req.body
  const editId = Date.now().toString() // מזהה ייחודי מינימלי

  pendingEdits.push({
    editId,
    anizone_id,
    editedBy: user,
    createdAt: new Date().toISOString(),
    newData,
  })

  io.emit('pendingEditsUpdated', pendingEdits)
  return res.json({ editId })
})

/**
 * (ד) נקודת GET לכל העריכות בהמתנה (לאדמין)
 */
app.get('/api/pending-edits', (req, res) => {
  res.json(pendingEdits)
})

/**
 * (ה) אישור עריכה:
 * - מוציא את האנימה מהקובץ הישן (data.json)
 * - ממזג לתוכה את השינויים (finalData)
 * - מוסיף את האנימה המעודכנת לקובץ approvedData.json
 * - מסיר מה-pendingEdits
 * - משחרר נעילה
 */
app.post('/api/pending-edits/:editId/approve', (req, res) => {
  const { editId } = req.params
  const updatedByAdmin = req.body.newData || {}

  const editIndex = pendingEdits.findIndex((p) => p.editId === editId)
  if (editIndex === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const pendingEdit = pendingEdits[editIndex]
  const animeId = pendingEdit.anizone_id

  // טוען את האנימות הישנות
  const oldAnimeList = loadAnimeData()

  // מחפש את האנימה הרלוונטית
  const animeIndex = oldAnimeList.findIndex((a) => a.anizone_id === animeId)
  if (animeIndex === -1) {
    return res.status(404).json({ error: 'Anime not found in data.json' })
  }

  // ממזגים את השינויים
  const finalData = {
    ...oldAnimeList[animeIndex],
    ...pendingEdit.newData,
    ...updatedByAdmin, // עדיפות לשינויים שהאדמין עשה
  }

  // 1. מסירים את האנימה מהקובץ הישן
  oldAnimeList.splice(animeIndex, 1)

  // 2. שומרים את הרשימה המעודכנת לקובץ data.json
  saveAnimeData(oldAnimeList)

  // 3. טוענים את הקובץ המאושר
  const approvedList = loadApprovedData()

  // 4. מוסיפים את האנימה (הממוזגת) לשם
  approvedList.push(finalData)

  // 5. שומרים
  saveApprovedData(approvedList)

  // 6. מורידים מה-pendingEdits
  pendingEdits.splice(editIndex, 1)

  // 7. משחררים נעילה (אם הייתה)
  locks = locks.filter((l) => l.anizone_id !== animeId)

  // 8. משדרים לכולם
  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true, updatedAnime: finalData })
})

/**
 * (ו) דחיית עריכה
 */
app.post('/api/pending-edits/:editId/reject', (req, res) => {
  const { editId } = req.params

  const editIndex = pendingEdits.findIndex((p) => p.editId === editId)
  if (editIndex === -1) {
    return res.status(404).json({ error: 'Pending edit not found' })
  }

  const animeId = pendingEdits[editIndex].anizone_id

  // מסירים את העריכה
  pendingEdits.splice(editIndex, 1)

  // משחררים נעילה
  locks = locks.filter((l) => l.anizone_id !== animeId)

  io.emit('locksUpdated', locks)
  io.emit('pendingEditsUpdated', pendingEdits)

  res.json({ success: true })
})

/**
 * (ז) שחרור נעילה
 */
app.post('/api/unlock/:animeId', (req, res) => {
  const animeId = parseInt(req.params.animeId, 10)

  locks = locks.filter((l) => l.anizone_id !== animeId)
  io.emit('locksUpdated', locks)

  res.sendStatus(200)
})

// --------------------------------
// 5) מסך לוגין פשוט לאדמין
// --------------------------------
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

// שים לב להוספת הגנה עם הטוקן אם תרצה (כמו /api/admin/pending-edits)
app.get('/api/admin/stats', (req, res) => {
  // בדיקת הרשאה (בדומה למסלול אחר)
  const { authorization } = req.headers
  if (authorization !== 'Bearer dummy-admin-token') {
    return res.status(403).json({ error: 'Not authorized' })
  }

  // טוענים את קובץ האנימות (שעדיין לא אושרו)
  const dataJson = loadAnimeData() // מערך מ data.json
  // טוענים את קובץ האנימות שאושרו
  const approvedJson = loadApprovedData() // מערך מ approvedData.json
  // כמות עריכות בהמתנה (in-memory)
  const totalPending = pendingEdits.length

  // סך הכל אנימות ב-data.json (עדיין לא אושרו)
  const totalData = dataJson.length
  // סך הכל אנימות שאושרו
  const totalApproved = approvedJson.length

  // סך הכל אנימות בשני הקבצים
  const totalOverall = totalData

  return res.json({
    totalData,
    totalApproved,
    totalPending,
    totalOverall,
  })
})

// --------------------------------
// 7) Socket.io event listeners
// --------------------------------
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id)
  socket.emit('locksUpdated', locks)
  socket.emit('pendingEditsUpdated', pendingEdits)

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id)
  })
})

app.use(express.static(path.join(__dirname, '../client/build')))

// נתיב ברירת מחדל לכל הבקשות שאינן API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/build', 'index.html'))
})

// --------------------------------
// 8) הפעלת השרת
// --------------------------------
const PORT = 3001
httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})
