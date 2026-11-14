import { useState, useEffect, useRef } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || ''
const readUsers = () => {
  try {
    return JSON.parse(localStorage.getItem('studybuddy-users') || '[]')
  } catch {
    return []
  }
}
const readChatHistory = (username) => {
  try {
    return JSON.parse(
      localStorage.getItem(`studybuddy-chat-${username}`) || '[]'
    )
  } catch {
    return []
  }
}
const subjectsKey = (username) => `studybuddy-subjects-${username}`
const readSavedSubjects = (username) => {
  try {
    const saved = JSON.parse(localStorage.getItem(subjectsKey(username)) || 'null')
    return Array.isArray(saved) ? saved : null
  } catch {
    return null
  }
}
const timeToMinutes = (time) => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}
const DAY_MS = 24 * 60 * 60 * 1000

// Decides WHICH calendar day the timetable's clock times belong to.
// - plan still running (even an overnight one started yesterday) -> keep that day
// - plan already finished today -> repeat it tomorrow
// This fixes the old bug where reloading / logging in mid-schedule pushed every alarm to tomorrow.
function pickScheduleStart(startTime, plan = []) {
  const [hours, minutes] = startTime.split(':').map(Number)
  const origin = hours * 60 + minutes
  const lastEnd = plan.length ? Math.max(...plan.map((item) => item.end)) : origin
  const span = (lastEnd - origin) * 60000

  const today = new Date()
  today.setHours(hours, minutes, 0, 0)
  const todayMs = today.getTime()
  const now = Date.now()

  if (todayMs - DAY_MS + span > now) return new Date(todayMs - DAY_MS)
  if (todayMs + span >= now - 60000) return new Date(todayMs)
  return new Date(todayMs + DAY_MS)
}

// ---------- Alarm sound & notifications ----------
let audioCtx = null

// One shared AudioContext (browsers limit how many you can create).
function getAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    if (!audioCtx) audioCtx = new Ctx()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

function playAlarmSound() {
  const ctx = getAudio()
  if (!ctx) return

  const notes = [659.25, 783.99, 987.77, 1318.51, 987.77, 1318.51]

  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = ctx.currentTime + i * 0.22

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.45)
  })
}

// Short soft sound used by the relaxing games.
function playBlip(freq = 520, type = 'sine', volume = 0.25, duration = 0.15) {
  const ctx = getAudio()
  if (!ctx) return

  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.6), t + duration)
  gain.gain.setValueAtTime(volume, t)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t)
  osc.stop(t + duration + 0.02)
}

function askNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  } catch {
    // Notifications are optional.
  }
}

function showNotification(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
  } catch {
    // Notifications are optional.
  }
}
const readSession = () => {
  try {
    const saved = JSON.parse(
      localStorage.getItem('studybuddy-session') || 'null'
    )

    if (!saved?.username) return null

    const user = readUsers().find(
      (u) => u.username.toLowerCase() === saved.username.toLowerCase()
    )

    return user ? { username: user.username } : null
  } catch {
    return null
  }
}
const formatTime = (minutes) => {
  const hours = Math.floor(minutes / 60) % 24
  const mins = minutes % 60
  const suffix = hours >= 12 ? 'PM' : 'AM'
  const displayHour = hours % 12 || 12
  return `${displayHour}:${String(mins).padStart(2, '0')} ${suffix}`
}

const sessionSettings = {
  Easy: { study: 25, rest: 5 },
  Medium: { study: 40, rest: 8 },
  Hard: { study: 50, rest: 10 },
}

function generatePlan(subjects, startTime, endTime) {
  const start = timeToMinutes(startTime)
  let remaining = timeToMinutes(endTime) - start

  if (remaining <= 0) remaining += 24 * 60

  const plan = []
  let clock = start
  let sessionCount = 0

  // Shuffle subjects so repeated plans can have different orders.
  const shuffled = [...subjects].sort(() => Math.random() - 0.5)
  let index = 0

  while (remaining >= 20 && sessionCount < 30) {
    const subject = shuffled[index % shuffled.length]
    const settings = sessionSettings[subject.difficulty]
    const longBreak = sessionCount > 0 && (sessionCount + 1) % 3 === 0
    const rest = longBreak ? 15 : settings.rest

    // Keep sessions long enough to be useful.
    const study = Math.min(settings.study, remaining)

    if (study < 20) break

    plan.push({
      id: `${Date.now()}-${sessionCount}-${Math.random()}`,
      subject: subject.name,
      difficulty: subject.difficulty,
      type: 'study',
      start: clock,
      end: clock + study,
    })

    clock += study
    remaining -= study
    sessionCount++

    // Breaks are scheduled only when another useful session can follow.
    if (remaining >= rest + 20) {
      plan.push({
        id: `${Date.now()}-break-${sessionCount}`,
        subject: longBreak ? 'Long break ☕' : 'Quick break 🌿',
        type: 'break',
        start: clock,
        end: clock + rest,
      })

      clock += rest
      remaining -= rest
    }

    index++
  }

  return plan
}

// ---------- Relaxing games ----------

function BubblePop() {
  const total = 24
  const fresh = () => Array.from({ length: total }, () => false)
  const [popped, setPopped] = useState(fresh)
  const [score, setScore] = useState(0)
  const count = popped.filter(Boolean).length

  function pop(index) {
    if (popped[index]) return
    playBlip(380 + Math.random() * 380, 'sine', 0.25, 0.14)

    const next = popped.map((value, i) => (i === index ? true : value))
    setPopped(next)
    setScore((value) => value + 1)

    if (next.every(Boolean)) {
      setTimeout(() => setPopped(fresh()), 700)
    }
  }

  return (
    <div className="game-play">
      <p className="helper-text game-hint">
        Tap the bubbles slowly. Pop one, breathe out. 🫧 Popped: <strong>{score}</strong>
      </p>
      <div className="bubble-grid">
        {popped.map((isPopped, index) => (
          <button
            key={index}
            className={`bubble ${isPopped ? 'bubble-popped' : ''}`}
            style={{ '--hue': (index * 37) % 360 }}
            onClick={() => pop(index)}
            aria-label={isPopped ? 'Popped bubble' : 'Pop bubble'}
          />
        ))}
      </div>
      {count === total && <p className="plan-message">All popped! Blowing fresh bubbles… ✨</p>}
    </div>
  )
}

const catLines = [
  'Purrrr… 😌',
  'The cat believes in you.',
  'Cat says: drink some water, human.',
  'Cat has reviewed your notes: acceptable.',
  'This cat has a PhD in napping.',
  'Meow means “take a deep breath”.',
  'The cat is now 12% less grumpy.',
  'Cat approves of your break. 🐾',
  'Cat refuses to study. Cat is wise.',
  'You are doing better than you think.',
]

function SleepyCat() {
  const [purrs, setPurrs] = useState(0)
  const [line, setLine] = useState('Psst… the cat is sleepy. Gently pet it.')
  const [hearts, setHearts] = useState([])

  const face = purrs === 0 ? '😴' : purrs < 5 ? '😺' : purrs < 12 ? '😸' : '😻'

  function pet() {
    playBlip(150 + Math.random() * 40, 'triangle', 0.3, 0.35)
    setPurrs((value) => value + 1)
    setLine(catLines[Math.floor(Math.random() * catLines.length)])

    const id = `${Date.now()}-${Math.random()}`
    const left = 30 + Math.random() * 40
    setHearts((list) => [...list, { id, left }])
    setTimeout(() => setHearts((list) => list.filter((h) => h.id !== id)), 1200)
  }

  return (
    <div className="game-play cat-area">
      <div className="cat-stage">
        {hearts.map((heart) => (
          <span key={heart.id} className="heart-float" style={{ left: `${heart.left}%` }}>
            💜
          </span>
        ))}
        <button className="cat-button" onClick={pet} aria-label="Pet the cat">
          {face}
        </button>
      </div>
      <p className="cat-line">{line}</p>
      <p className="helper-text">Purr level: <strong>{purrs}</strong></p>
    </div>
  )
}

const memoryEmojis = ['🌸', '🍵', '🦋', '🌙', '🐢', '🍀', '☁️', '🐝']

function shuffledDeck() {
  const deck = [...memoryEmojis, ...memoryEmojis].map((emoji, id) => ({ id, emoji }))

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = deck[i]
    deck[i] = deck[j]
    deck[j] = temp
  }

  return deck
}

function MemoryMatch() {
  const [deck, setDeck] = useState(shuffledDeck)
  const [flipped, setFlipped] = useState([])
  const [matched, setMatched] = useState([])
  const [moves, setMoves] = useState(0)

  const won = matched.length === deck.length

  function flip(card) {
    if (flipped.length === 2) return
    if (flipped.includes(card.id) || matched.includes(card.id)) return

    playBlip(520, 'sine', 0.2, 0.12)
    const next = [...flipped, card.id]
    setFlipped(next)

    if (next.length === 2) {
      setMoves((value) => value + 1)
      const [a, b] = next.map((id) => deck.find((c) => c.id === id))

      if (a.emoji === b.emoji) {
        setMatched((list) => [...list, a.id, b.id])
        setFlipped([])
        playBlip(880, 'triangle', 0.25, 0.3)
      } else {
        setTimeout(() => setFlipped([]), 800)
      }
    }
  }

  function restart() {
    setDeck(shuffledDeck())
    setFlipped([])
    setMatched([])
    setMoves(0)
  }

  return (
    <div className="game-play">
      <p className="helper-text game-hint">
        Find the matching pairs. No rush, no score to beat. Moves: <strong>{moves}</strong>
      </p>
      <div className="memory-grid">
        {deck.map((card) => {
          const open = flipped.includes(card.id) || matched.includes(card.id)
          return (
            <button
              key={card.id}
              className={`memory-card ${open ? 'memory-open' : ''} ${matched.includes(card.id) ? 'memory-matched' : ''}`}
              onClick={() => flip(card)}
              aria-label={open ? card.emoji : 'Hidden card'}
            >
              {open ? card.emoji : '✦'}
            </button>
          )
        })}
      </div>
      {won && <p className="plan-message">You found them all in {moves} moves! 🌸</p>}
      <div className="builder-actions">
        <button className="secondary-btn" onClick={restart}>New game ↻</button>
      </div>
    </div>
  )
}

const jokes = [
  'Why did the student eat his homework? The teacher said it was a piece of cake. 🍰',
  'I told my brain we would study for 5 minutes. It started thinking about snacks. 🍕',
  'Why don’t scientists trust atoms? They make up everything! ⚛️',
  'My notes and I have a lot in common. We’re both a mess, but somehow it works. 📓',
  'Why was the math book sad? It had too many problems. ➕',
  'What do you call a sleeping dinosaur? A dino-snore! 🦕',
  'I’m reading a book about anti-gravity. It’s impossible to put down! 📖',
  'Why did the clock get a gold star? It was always on time. ⏰',
  'Procrastination is just the art of keeping up with yesterday. 🐌',
  'Why did the computer go to the doctor? It caught a virus. 💻',
  'What’s a ghost’s favourite subject? Boo-logy! 👻',
  'Why did the teacher wear sunglasses? Because her class was so bright! 😎',
]

function JokeBox() {
  const [joke, setJoke] = useState(jokes[0])
  const [laughs, setLaughs] = useState(0)

  function nextJoke() {
    const others = jokes.filter((item) => item !== joke)
    setJoke(others[Math.floor(Math.random() * others.length)])
    playBlip(660, 'triangle', 0.2, 0.2)
  }

  return (
    <div className="game-play">
      <p className="joke-text">{joke}</p>
      <div className="builder-actions">
        <button className="primary-btn" onClick={nextJoke}>Tell me another 🤡</button>
        <button
          className="secondary-btn"
          onClick={() => {
            setLaughs((value) => value + 1)
            playBlip(900, 'sine', 0.2, 0.15)
          }}
        >
          😂 Haha ({laughs})
        </button>
      </div>
    </div>
  )
}

const games = [
  { id: 'bubbles', emoji: '🫧', title: 'Bubble pop', blurb: 'Pop soft bubbles, one at a time.', Component: BubblePop },
  { id: 'cat', emoji: '😺', title: 'Sleepy cat', blurb: 'Pet the cat. It has opinions.', Component: SleepyCat },
  { id: 'memory', emoji: '🌸', title: 'Calm memory', blurb: 'Match the pairs, no timer pressure.', Component: MemoryMatch },
  { id: 'jokes', emoji: '🤡', title: 'Silly joke box', blurb: 'Groan-worthy study jokes.', Component: JokeBox },
]

const breathPhases = [
  { label: 'Breathe in…', seconds: 4, scale: 1.5 },
  { label: 'Hold…', seconds: 4, scale: 1.5 },
  { label: 'Breathe out…', seconds: 6, scale: 1 },
]

const breakIdeas = [
  '👀 20-20-20: look at something 20 feet away for 20 seconds.',
  '🙆 Roll your shoulders back 10 times, slowly.',
  '💧 Drink a full glass of water.',
  '🧍 Stand up and stretch your arms overhead for 30 seconds.',
  '🪟 Look out of a window and name 5 things you can see.',
  '🤲 Shake out your hands and wrists, then gently stretch your fingers.',
  '🚶 Walk around the room or step outside for two minutes.',
  '🎧 Listen to one calm song with your eyes closed.',
  '🍎 Have a small healthy snack, away from your desk.',
  '😮‍💨 Do three slow neck rolls each way.',
]

const formatCountdown = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`

// breakEndsAt: when a scheduled break is running, the page follows it and closes itself when it ends.
// Otherwise a free break timer starts when the person starts a game (or presses "Start break timer").
function MindfulBreaks({ breakEndsAt, onBack, onTimeUp }) {
  const [scheduledEnd] = useState(breakEndsAt)
  const [freeEndsAt, setFreeEndsAt] = useState(null)
  const [freeMinutes, setFreeMinutes] = useState(5)
  const [now, setNow] = useState(() => Date.now())
  const timeUpSent = useRef(false)

  const [activeGame, setActiveGame] = useState(null)
  const [breathing, setBreathing] = useState(false)
  const [phase, setPhase] = useState(0)
  const [cycles, setCycles] = useState(0)
  const [idea, setIdea] = useState(breakIdeas[0])

  const endsAt = scheduledEnd || freeEndsAt
  const remaining = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : 0

  // Countdown + auto close when the break is over
  useEffect(() => {
    if (!endsAt) return

    timeUpSent.current = false

    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)

      if (current >= endsAt && !timeUpSent.current) {
        timeUpSent.current = true
        onTimeUp(scheduledEnd ? 'scheduled' : 'free')
      }
    }, 500)

    return () => clearInterval(timer)
  }, [endsAt])

  // Breathing guide: in 4s -> hold 4s -> out 6s
  useEffect(() => {
    if (!breathing) return

    const timer = setTimeout(() => {
      const next = (phase + 1) % breathPhases.length
      if (next === 0) setCycles((count) => count + 1)
      setPhase(next)
    }, breathPhases[phase].seconds * 1000)

    return () => clearTimeout(timer)
  }, [breathing, phase])

  function startFreeTimer(minutes = freeMinutes) {
    getAudio()
    setNow(Date.now())
    setFreeEndsAt(Date.now() + minutes * 60000)
  }

  function startGame(id) {
    setActiveGame(id)
    // Starting a game starts the break timer if one is not already running.
    if (!endsAt) startFreeTimer()
  }

  function toggleBreathing() {
    if (breathing) {
      setBreathing(false)
      setPhase(0)
    } else {
      setCycles(0)
      setPhase(0)
      setBreathing(true)
      if (!endsAt) startFreeTimer()
    }
  }

  function newIdea() {
    const others = breakIdeas.filter((item) => item !== idea)
    setIdea(others[Math.floor(Math.random() * others.length)])
  }

  const current = breathPhases[phase]
  const game = games.find((item) => item.id === activeGame)

  return (
    <main className="builder-page">
      <button className="back-btn" onClick={onBack}>← Dashboard</button>

      {endsAt && (
        <div className={`break-timer-bar ${remaining <= 30 ? 'break-timer-low' : ''}`} role="timer">
          <span>
            {scheduledEnd ? '☕ Your break ends in' : '⏱️ This page closes in'}
          </span>
          <strong>{formatCountdown(remaining)}</strong>
          {!scheduledEnd && (
            <button className="text-btn" onClick={() => setFreeEndsAt(null)}>Stop timer</button>
          )}
        </div>
      )}

      <div className="tag">✦ REST • PLAY • RETURN</div>
      <h1>Mindful <span>breaks.</span> ☕</h1>
      <p className="description">
        {scheduledEnd
          ? 'Enjoy a little game. This page closes by itself when your break is over.'
          : 'Short, gentle pauses help you remember more. Pick something relaxing.'}
      </p>

      <section className="builder-card">
        <h2>1. Relax with a game 🎮</h2>
        <div className="game-grid">
          {games.map((item) => (
            <button
              key={item.id}
              className={`game-card ${activeGame === item.id ? 'game-card-active' : ''}`}
              onClick={() => startGame(item.id)}
            >
              <span className="emoji">{item.emoji}</span>
              <strong>{item.title}</strong>
              <small>{item.blurb}</small>
            </button>
          ))}
        </div>

        {game && (
          <div className="game-panel">
            <div className="results-heading">
              <h2>{game.emoji} {game.title}</h2>
              <button className="text-btn" onClick={() => setActiveGame(null)}>Close game</button>
            </div>
            <game.Component />
          </div>
        )}
      </section>

      <section className="builder-card">
        <h2>2. Breathe with me 🌿</h2>
        <div className="breath-area">
          <div
            className="breath-circle"
            style={{
              transform: `scale(${breathing ? current.scale : 1})`,
              transitionDuration: breathing ? `${current.seconds}s` : '0.6s',
            }}
          >
            <span>{breathing ? current.label : 'Ready?'}</span>
          </div>
        </div>
        <p className="helper-text breath-count">
          {breathing
            ? `Breath cycles completed: ${cycles}`
            : 'In for 4 seconds, hold for 4, out for 6. Repeat a few times.'}
        </p>
        <div className="builder-actions timer-actions">
          <button className="primary-btn" onClick={toggleBreathing}>
            {breathing ? 'Stop' : 'Start breathing'}
          </button>
        </div>
      </section>

      {!scheduledEnd && (
        <section className="builder-card">
          <h2>3. Break timer ⏱️</h2>
          <p className="helper-text">
            Starting a game starts this timer for you. When it ends, this page closes and an alarm lets you know.
          </p>
          <div className="timer-presets">
            {[5, 10, 15].map((value) => (
              <button
                key={value}
                className={`secondary-btn ${freeMinutes === value ? 'preset-active' : ''}`}
                onClick={() => setFreeMinutes(value)}
                disabled={!!freeEndsAt}
              >
                {value} min
              </button>
            ))}
          </div>
          <div className="builder-actions timer-actions">
            {freeEndsAt ? (
              <button className="secondary-btn" onClick={() => setFreeEndsAt(null)}>Stop timer</button>
            ) : (
              <button className="primary-btn" onClick={() => startFreeTimer()}>Start break timer</button>
            )}
          </div>
        </section>
      )}

      <section className="builder-card">
        <h2>{scheduledEnd ? '3' : '4'}. Need an idea? ✨</h2>
        <p className="break-idea">{idea}</p>
        <div className="builder-actions">
          <button className="secondary-btn" onClick={newIdea}>Another idea ↻</button>
        </div>
      </section>

      <p className="footer-note">Rest is part of studying, not a break from it. ♡</p>
    </main>
  )
}

function App() {
  const [page, setPage] = useState(() => (readSession() ? 'dashboard' : 'home'))
  const [users, setUsers] = useState(readUsers)
  const [currentUser, setCurrentUser] = useState(readSession)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')

  const [subjects, setSubjects] = useState([])
  const [subjectName, setSubjectName] = useState('')
  const [difficulty, setDifficulty] = useState('Medium')
  const [startTime, setStartTime] = useState('18:00')
  const [endTime, setEndTime] = useState('23:30')
  const [plan, setPlan] = useState([])
  const [planMessage, setPlanMessage] = useState('')
  const [activeSchedule, setActiveSchedule] = useState([])
  const [alarmEvent, setAlarmEvent] = useState(null)
  const firedAlarms = useRef(new Set())
  const [scheduleStartAt, setScheduleStartAt] = useState(null)
  const [chatMessages, setChatMessages] = useState(() => {
  const session = readSession()
  return session ? readChatHistory(session.username) : []
  })
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  function signup(e) {
    e.preventDefault()
    const cleanName = username.trim()

    if (users.some((u) => u.username.toLowerCase() === cleanName.toLowerCase())) {
      setMessage('That username already exists. Please log in.')
      return
    }

    const updated = [...users, { username: cleanName, password }]
    setUsers(updated)
    localStorage.setItem('studybuddy-users', JSON.stringify(updated))
    setCurrentUser({ username: cleanName })
    localStorage.setItem(
      'studybuddy-session',
    JSON.stringify({ username: cleanName })
    )
    setChatMessages([])
    setMessage('')
    setPage('dashboard')
  }
  useEffect(() => {
  if (!currentUser) return

  localStorage.setItem(
    `studybuddy-chat-${currentUser.username}`,
    JSON.stringify(chatMessages)
  )
}, [currentUser, chatMessages])
  useEffect(() => {
  if (!currentUser) {
    setActiveSchedule([])
    setScheduleStartAt(null)
    return
  }

  // Subjects are saved the moment you add them, so restore them first
  // (this also clears the previous user's subjects after switching accounts).
  const savedSubjects = readSavedSubjects(currentUser.username)
  setSubjects(savedSubjects || [])

  const saved = localStorage.getItem(
    `studybuddy-plan-${currentUser.username}`
  )

  if (!saved) return

  try {
    const data = JSON.parse(saved)

    if (!data.plan?.length) return

    setSubjects(savedSubjects || data.subjects || [])
    setStartTime(data.startTime || '18:00')
    setEndTime(data.endTime || '23:30')
    setPlan(data.plan)
    setActiveSchedule(data.plan)
    setScheduleStartAt(
      pickScheduleStart(data.startTime || '18:00', data.plan)
    )

    firedAlarms.current.clear()
  } catch (error) {
    console.error('Could not restore timetable:', error)
  }
  }, [currentUser])
  
  
useEffect(() => {
  if (!currentUser || !scheduleStartAt || activeSchedule.length === 0) {
    return
  }

  const origin = timeToMinutes(startTime)
  const at = (minute) => scheduleStartAt.getTime() + (minute - origin) * 60000
  const finalEnd = Math.max(...activeSchedule.map((item) => item.end))

  const alarms = [
    ...activeSchedule.map((item, index) => {
      const time = at(item.start)
      const minutes = item.end - item.start

      if (item.type === 'break') {
        const next = activeSchedule.slice(index + 1).find((s) => s.type === 'study')
        return {
          id: `start-${item.id}-${time}`,
          time,
          title: 'Break time! ☕',
          message: `Relax for ${minutes} minutes.${next ? ` Up next: ${next.subject}.` : ''} Play a relaxing game in Mindful breaks 🎮`,
          breakEndsAt: at(item.end),
        }
      }

      return {
        id: `start-${item.id}-${time}`,
        time,
        title: `Study time: ${item.subject} 📚`,
        message: `${minutes} minutes of focus. Let’s do our best! 💜`,
      }
    }),
    {
      id: `timetable-finished-${at(finalEnd)}`,
      time: at(finalEnd),
      title: 'You did it! 🎉',
      message: 'Your timetable is complete. Great work!',
    },
  ]

  const checkAlarms = () => {
    const now = Date.now()
    const due = alarms.filter(
      (alarm) => now >= alarm.time && !firedAlarms.current.has(alarm.id)
    )

    if (due.length === 0) return

    due.forEach((alarm) => firedAlarms.current.add(alarm.id))

    // Only ring for alarms that are due right now (within 2 minutes).
    // Older ones are marked as done silently so reloading never replays the past.
    const live = due.filter((alarm) => now - alarm.time <= 2 * 60000)
    if (live.length === 0) return

    const latest = live.reduce((a, b) => (b.time > a.time ? b : a))
    setAlarmEvent(latest)
    showNotification(latest.title, latest.message)
  }

  checkAlarms()

  // A Web Worker keeps ticking even when the tab is in the background
  // (normal timers get throttled to about once a minute there).
  let worker
  let workerUrl
  let fallbackTimer

  try {
    const blob = new Blob(['setInterval(() => postMessage(1), 1000)'], {
      type: 'text/javascript',
    })
    workerUrl = URL.createObjectURL(blob)
    worker = new Worker(workerUrl)
    worker.onmessage = checkAlarms
  } catch {
    fallbackTimer = setInterval(checkAlarms, 1000)
  }

  document.addEventListener('visibilitychange', checkAlarms)

  return () => {
    worker?.terminate()
    if (workerUrl) URL.revokeObjectURL(workerUrl)
    clearInterval(fallbackTimer)
    document.removeEventListener('visibilitychange', checkAlarms)
  }
}, [currentUser, activeSchedule, scheduleStartAt, startTime])

// Ring (and repeat every 3s) until the popup is dismissed.
useEffect(() => {
  if (!alarmEvent) return

  playAlarmSound()
  const timer = setInterval(playAlarmSound, 3000)

  return () => clearInterval(timer)
}, [alarmEvent])

// Browsers only allow sound after the person has interacted with the page,
// so unlock audio on the first click/tap.
useEffect(() => {
  const unlock = () => getAudio()
  window.addEventListener('pointerdown', unlock, { once: true })
  return () => window.removeEventListener('pointerdown', unlock)
}, [])


  function login(e) {
    e.preventDefault()

    const user = users.find(
      (u) =>
        u.username.toLowerCase() === username.trim().toLowerCase() &&
        u.password === password
    )

    if (!user) {
      setMessage('Incorrect details, or account not found. Try signing up.')
      return
    }

    setCurrentUser({ username: user.username })
    localStorage.setItem(
    'studybuddy-session',
    JSON.stringify({ username: user.username })
    )
    setChatMessages(readChatHistory(user.username))
    setMessage('')
    setPage('dashboard')
  }

  function logout() {
    localStorage.removeItem('studybuddy-session')
    setCurrentUser(null)
    setChatMessages([])
    setUsername('')
    setPassword('')
    setMessage('')
    setPage('home')
  }

  function openBuilder() {
    const saved = currentUser
      ? localStorage.getItem(`studybuddy-plan-${currentUser.username}`)
      : null

    if (saved) {
      try {
        const data = JSON.parse(saved)
        setSubjects(readSavedSubjects(currentUser.username) || data.subjects || [])
        setStartTime(data.startTime || '18:00')
        setEndTime(data.endTime || '23:30')
        setPlan(data.plan || [])
        setActiveSchedule(data.plan || [])
        setScheduleStartAt(
          pickScheduleStart(data.startTime || '18:00', data.plan || [])
        )
      firedAlarms.current.clear()
      } catch {
        setPlan([])
      }
    } else {
      setSubjects(currentUser ? readSavedSubjects(currentUser.username) || [] : [])
      setPlan([])
      setActiveSchedule([])
      setScheduleStartAt(null)
    }

    setPlanMessage('')
    setPage('builder')
  }

  function saveSubjects(list) {
    if (currentUser) {
      localStorage.setItem(subjectsKey(currentUser.username), JSON.stringify(list))
    }
  }

  function addSubject(e) {
    e.preventDefault()
    const cleanName = subjectName.trim()

    if (!cleanName) return

    if (subjects.some((s) => s.name.toLowerCase() === cleanName.toLowerCase())) {
      setPlanMessage('That subject is already on your list.')
      return
    }

    const updatedSubjects = [
      ...subjects,
      {
        id: `${Date.now()}-${Math.random()}`,
        name: cleanName,
        difficulty,
      },
    ]

    setSubjects(updatedSubjects)
    saveSubjects(updatedSubjects)
    setSubjectName('')
    setPlanMessage('')
  }

function removeSubject(id) {
  const updatedSubjects = subjects.filter(
    (subject) => subject.id !== id
  )

  setSubjects(updatedSubjects)
  saveSubjects(updatedSubjects)
  setPlan([])
  setActiveSchedule([])
  setAlarmEvent(null)
  setScheduleStartAt(null)
  firedAlarms.current.clear()
  setPlanMessage('Subject removed. Generate a new timetable.')

  if (currentUser) {
    localStorage.removeItem(
      `studybuddy-plan-${currentUser.username}`
    )
  }
}

function changeDifficulty(id, value) {
  const updatedSubjects = subjects.map((subject) =>
    subject.id === id
      ? { ...subject, difficulty: value }
      : subject
  )

  setSubjects(updatedSubjects)
  saveSubjects(updatedSubjects)
  setPlan([])
  setActiveSchedule([])
  setAlarmEvent(null)
  setScheduleStartAt(null)
  firedAlarms.current.clear()
  setPlanMessage('Difficulty updated. Generate a new timetable.')

  if (currentUser) {
    localStorage.removeItem(
      `studybuddy-plan-${currentUser.username}`
    )
  }
}

function updateStartTime(newTime) {
  const oldStart = timeToMinutes(startTime)
  const newStart = timeToMinutes(newTime)

  const updatedPlan = plan.map((item) => {
    const offset = item.start - oldStart
    const duration = item.end - item.start

    return {
      ...item,
      start: newStart + offset,
      end: newStart + offset + duration,
    }
  })

  setStartTime(newTime)
  setPlan(updatedPlan)
  setActiveSchedule(updatedPlan)
  firedAlarms.current.clear()
  setScheduleStartAt(pickScheduleStart(newTime, updatedPlan))

  if (currentUser && updatedPlan.length) {
    localStorage.setItem(
      `studybuddy-plan-${currentUser.username}`,
      JSON.stringify({
        subjects,
        startTime: newTime,
        endTime,
        plan: updatedPlan,
      })
    )
  }
}



function updateEndTime(newTime) {
  const start = timeToMinutes(startTime)
  let end = timeToMinutes(newTime)

  if (end <= start) end += 1440

  const updatedPlan = plan
    .filter((item) => item.start < end)
    .map((item) => ({
      ...item,
      end: Math.min(item.end, end),
    }))
    .filter((item) => item.end > item.start)

  setEndTime(newTime)
  setPlan(updatedPlan)
  setActiveSchedule(updatedPlan)
  firedAlarms.current.clear()

  if (currentUser) {
    localStorage.setItem(
      `studybuddy-plan-${currentUser.username}`,
      JSON.stringify({
        subjects,
        startTime,
        endTime: newTime,
        plan: updatedPlan,
      })
    )
  }
}


function createTimetable() {
  if (subjects.length === 0) {
    setPlanMessage('Add at least one subject first.')
    return
  }

  const start = timeToMinutes(startTime)
  let end = timeToMinutes(endTime)

  if (end <= start) end += 24 * 60

  if (end - start < 30) {
    setPlanMessage('Please choose an available time of at least 30 minutes.')
    return
  }

  const generated = generatePlan(subjects, startTime, endTime)

  setPlan(generated)
setActiveSchedule(generated)
firedAlarms.current.clear()

if (currentUser && generated.length > 0) {
  localStorage.setItem(
    `studybuddy-plan-${currentUser.username}`,
    JSON.stringify({
      subjects,
      startTime,
      endTime,
      plan: generated,
    })
  )
}
  setScheduleStartAt(pickScheduleStart(startTime, generated))
  askNotificationPermission()
  getAudio()

  setPlanMessage(
    generated.length
      ? 'Your plan is ready! Alarms are scheduled 💜'
      : 'Not enough time for a useful study session. Extend your availability.'
  )
}


  // If a scheduled break is running right now, returns when it ends (ms), else null.
  function getCurrentBreakEnd() {
    if (!scheduledReady()) return null

    const origin = timeToMinutes(startTime)
    const at = (minute) => scheduleStartAt.getTime() + (minute - origin) * 60000
    const now = Date.now()

    const current = activeSchedule.find(
      (item) => item.type === 'break' && now >= at(item.start) && now < at(item.end)
    )

    return current ? at(current.end) : null
  }

  function scheduledReady() {
    return !!scheduleStartAt && activeSchedule.length > 0
  }

  function goToBreaks() {
    setAlarmEvent(null)
    setPage('breaks')
  }

  function handleBreakTimeUp(kind) {
    setPage('dashboard')

    // For a scheduled break the next study alarm rings by itself at this exact time.
    if (kind === 'free') {
      setAlarmEvent({
        id: `break-timer-${Date.now()}`,
        title: 'Break over! ⏰',
        message: 'Feeling refreshed? Time to get back to it 💜',
      })
    }
  }

  function testAlarm() {
    getAudio()
    askNotificationPermission()
    setAlarmEvent({
      id: `test-${Date.now()}`,
      title: 'Test alarm 🔔',
      message: 'If you can hear this and see this popup, your alarms are working!',
    })
  }

  function saveTimetable() {
    if (!currentUser || plan.length === 0) return

    const data = { subjects, startTime, endTime, plan }
    localStorage.setItem(
      `studybuddy-plan-${currentUser.username}`,
      JSON.stringify(data)
    )
    setPlanMessage('Timetable saved on this device! 💜')
  }

  function editSession(id, value) {
  const updatedPlan = plan.map((item) =>
    item.id === id && item.type === "study"
      ? { ...item, subject: value }
      : item
  )

  setPlan(updatedPlan)
  setActiveSchedule(updatedPlan)

  if (currentUser) {
    localStorage.setItem(
      `studybuddy-plan-${currentUser.username}`,
      JSON.stringify({ subjects, startTime, endTime, plan: updatedPlan })
    )
  }
}

function moveSession(id, direction) {
  const updatedPlan = plan.map((item) => ({ ...item }))
  const index = updatedPlan.findIndex((item) => item.id === id)

  if (index === -1 || updatedPlan[index].type !== "study") return

  let nextIndex = index + direction

  while (
    nextIndex >= 0 &&
    nextIndex < updatedPlan.length &&
    updatedPlan[nextIndex].type !== "study"
  ) {
    nextIndex += direction
  }

  if (nextIndex < 0 || nextIndex >= updatedPlan.length) return

  const firstDuration =
    updatedPlan[index].end - updatedPlan[index].start
  const secondDuration =
    updatedPlan[nextIndex].end - updatedPlan[nextIndex].start

  ;[updatedPlan[index], updatedPlan[nextIndex]] = [
    updatedPlan[nextIndex],
    updatedPlan[index],
  ]

  // Keep each moved session's original duration.
  const durations = updatedPlan.map((item, i) =>
    i === index
      ? secondDuration
      : i === nextIndex
        ? firstDuration
        : item.end - item.start
  )

  let cursor = timeToMinutes(startTime)

  updatedPlan.forEach((item, i) => {
    item.start = cursor
    item.end = cursor + durations[i]
    cursor = item.end
  })

  setPlan(updatedPlan)
  setActiveSchedule(updatedPlan)
  firedAlarms.current.clear()

  if (currentUser) {
    localStorage.setItem(
      `studybuddy-plan-${currentUser.username}`,
      JSON.stringify({ subjects, startTime, endTime, plan: updatedPlan })
    )
  }
}

  
async function sendStudyQuestion(e) {
  e.preventDefault()

  const question = chatInput.trim()
  if (!question || chatLoading) return

  const updatedMessages = [
    ...chatMessages,
    { role: 'user', content: question },
  ]

  setChatMessages(updatedMessages)
  setChatInput('')
  setChatLoading(true)

  try {
    const response = await fetch(`${API_URL}/api/study-assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history: chatMessages.slice(-10),
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'Could not get an answer.')
    }

    setChatMessages([
      ...updatedMessages,
      { role: 'assistant', content: data.answer },
    ])
  } catch (error) {
    setChatMessages([
      ...updatedMessages,
      {
        role: 'assistant',
        content: `Sorry! ${error.message} Please check that your AI server is running.`,
      },
    ])
  } finally {
    setChatLoading(false)
  }
}

  const nav = (
    <>
    <nav className="navbar">
      <button className="brand-button" onClick={() => setPage(currentUser ? 'dashboard' : 'home')}>
        <span className="logo">studybuddy<span>✦</span></span>
      </button>
      {currentUser ? (
        <div className="nav-actions">
          <span className="welcome-user">Hi, {currentUser.username}!</span>
          <button className="login-btn" onClick={logout}>Log out</button>
        </div>
      ) : page === 'home' ? (
        <button className="login-btn" onClick={() => { setPage('login'); setMessage('') }}>
          Log in
        </button>
      ) : (
        <button className="login-btn" onClick={() => { setPage('home'); setMessage('') }}>
          ← Home
        </button>
      )}
    </nav>
        {alarmEvent && (
      <div className="alarm-overlay" role="dialog" aria-modal="true">
        <div className="alarm-popup">
          <div className="alarm-icon">🔔</div>

          <h2>{alarmEvent.title}</h2>
          <p>{alarmEvent.message}</p>

          <div className="alarm-actions">
            {alarmEvent.breakEndsAt && (
              <button className="primary-btn" onClick={goToBreaks}>
                🌿 Relax with a game
              </button>
            )}
            <button
              className={alarmEvent.breakEndsAt ? 'secondary-btn' : 'primary-btn'}
              onClick={() => setAlarmEvent(null)}
            >
              {alarmEvent.breakEndsAt ? 'Okay, thanks' : "Okay, let's go! 💜"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )

  if (page === 'login' || page === 'signup') {
    const isSignup = page === 'signup'

    return (
      <div className="app">
        {nav}
        <main className="auth-card">
          <div className="tag">✦ YOUR SPACE, YOUR PACE</div>
          <h1>{isSignup ? 'Join StudyBuddy' : 'Welcome back!'}</h1>
          <p className="description">
            {isSignup ? 'Create your own little study space.' : 'Ready for another productive day?'}
          </p>

          <form onSubmit={isSignup ? signup : login}>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="Choose a username" autoComplete="username" required />

            <label>Password</label>
            <input type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete={isSignup ? 'new-password' : 'current-password'} required />

            {message && <p className="error-message">{message}</p>}
            <button className="primary-btn form-btn" type="submit">
              {isSignup ? 'Create account →' : 'Log in →'}
            </button>
          </form>

          <p className="switch-text">
            {isSignup ? 'Already have an account?' : 'New to StudyBuddy?'}{' '}
            <button className="text-btn" onClick={() => {
              setPage(isSignup ? 'login' : 'signup')
              setMessage('')
            }}>
              {isSignup ? 'Log in' : 'Sign up'}
            </button>
          </p>
        </main>
      </div>
    )
  }

  if (page === 'dashboard' && currentUser) {
    return (
      <div className="app">
        {nav}
        <main className="dashboard-page">
          <div className="tag">✦ YOUR PERSONAL STUDY SPACE</div>
          <h1>Hey, {currentUser.username}! <span>💜</span></h1>
          <p className="description">Let's make today count, one session at a time.</p>

          <div className="dashboard-grid">
            <div className="dashboard-card lavender">
              <span className="emoji">📚</span>
              <h3>Smart timetable</h3>
              <p>Plan your subjects around your available time.</p>
              <button className="primary-btn" onClick={openBuilder}>Create my timetable →</button>
            </div>
            <div className="dashboard-card peach">
              <span className="emoji">🧠</span>
              <h3>Study assistant</h3>
              <p>Ask doubts and learn concepts with AI.</p>
              <button
              className="primary-btn"
              onClick={() => setPage('assistant')}
              >
              Ask a doubt →
              </button>
            </div>
            <div className="dashboard-card mint">
              <span className="emoji">☕</span>
              <h3>Mindful breaks</h3>
              <p>Take a breather between your sessions.</p>
              <button className="primary-btn" onClick={() => setPage('breaks')}>Take a break →</button>
            </div>
          </div>
        </main>
      </div>
    )
  }
  
  if (page === 'breaks' && currentUser) {
    return (
      <div className="app">
        {nav}
        <MindfulBreaks
          breakEndsAt={getCurrentBreakEnd()}
          onBack={() => setPage('dashboard')}
          onTimeUp={handleBreakTimeUp}
        />
      </div>
    )
  }

  if (page === 'assistant' && currentUser) {
    return (
      <div className="app">
        {nav}
        <main className="builder-page">
          <button className="back-btn" onClick={() => setPage('dashboard')}>
            ← Dashboard
          </button>

          <div className="tag">✦ YOUR AI STUDY PARTNER</div>
          <h1>Ask away, <span>curious mind.</span> 🧠</h1>
          <p className="description">
            Ask academic questions and understand concepts at your own pace.
          </p>

          <section className="builder-card chat-card">
            <div className="chat-messages">
              {chatMessages.length === 0 && (
                <div className="chat-welcome">
                  <span className="emoji">💜</span>
                  <h2>What are we learning today?</h2>
                  <p>Try asking me to explain a difficult concept simply.</p>
                  <button
                    className="secondary-btn"
                    onClick={() => setChatInput('Explain recursion in simple words with an example.')}
                  >
                    Explain recursion ✨
                  </button>
                  <button
                    className="secondary-btn"
                    onClick={() => setChatInput('Give me 5 practice questions on data structures.')}
                  >
                    Practice questions 📚
                  </button>
                </div>
              )}

              {chatMessages.map((msg, index) => (
                <div
                  key={index}
                  className={`chat-message ${msg.role === 'user' ? 'user-message' : 'ai-message'}`}
                >
                  <strong>{msg.role === 'user' ? 'You' : 'StudyBuddy AI'}</strong>
                  <p>{msg.content}</p>
                </div>
              ))}

              {chatLoading && (
                <div className="chat-message ai-message">
                  <strong>StudyBuddy AI</strong>
                  <p>Thinking about it... ✨</p>
                </div>
              )}
            </div>

            <form className="chat-form" onSubmit={sendStudyQuestion}>
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask your study doubt here..."
                rows={3}
                required
              />
              <button className="primary-btn" type="submit" disabled={chatLoading}>
                {chatLoading ? 'Thinking...' : 'Send ✦'}
              </button>
            </form>

            <button
              className="text-btn"
              onClick={() => setChatMessages([])}
            >
              Clear conversation
            </button>
          </section>
        </main>
      </div>
    )
  }

  if (page === 'builder' && currentUser) {
    return (
      <div className="app">
        {nav}
        <main className="builder-page">
          <button className="back-btn" onClick={() => setPage('dashboard')}>← Dashboard</button>
          <div className="tag">✦ YOUR STUDY PLAN</div>
          <h1>Build your <span>timetable.</span></h1>
          <p className="description">Tell us what you're studying and when you're free.</p>

          <section className="builder-card">
            <h2>1. Add your subjects 📚</h2>
            <form className="subject-form" onSubmit={addSubject}>
              <input value={subjectName} onChange={(e) => setSubjectName(e.target.value)}
                placeholder="e.g. Mathematics" aria-label="Subject name" required />
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}
                aria-label="Subject difficulty">
                <option>Easy</option>
                <option>Medium</option>
                <option>Hard</option>
              </select>
              <button className="primary-btn" type="submit">+ Add</button>
            </form>

            {subjects.length === 0 ? (
              <p className="empty-note">Your subjects will appear here.</p>
            ) : (
              <div className="subject-list">
                {subjects.map((subject) => (
                  <div className="subject-row" key={subject.id}>
                    <span className="subject-dot">✦</span>
                    <strong>{subject.name}</strong>
                    <select value={subject.difficulty}
                      onChange={(e) => changeDifficulty(subject.id, e.target.value)}
                      aria-label={`${subject.name} difficulty`}>
                      <option>Easy</option><option>Medium</option><option>Hard</option>
                    </select>
                    <button className="remove-btn" onClick={() => removeSubject(subject.id)}
                      aria-label={`Remove ${subject.name}`}>×</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="builder-card">
            <h2>2. When are you available? 🕒</h2>
            <div className="time-fields">
              <label>Start time
                <input type="time" value={startTime} onChange={(e) => updateStartTime(e.target.value)} />
              </label>
              <label>End time
                <input type="time" value={endTime} onChange={(e) => updateEndTime(e.target.value)} />
              </label>
            </div>
            <p className="helper-text">Example: 6:00 PM to 11:30 PM. Overnight schedules are supported.</p>
          </section>

          <section className="builder-card">
            <h2>3. Generate your plan ✨</h2>
            <p className="helper-text">
              Hard subjects get longer sessions. Breaks adjust to difficulty, with a longer break after every three study sessions. Each generation randomizes the subject order.
            </p>
            <div className="builder-actions">
              <button className="primary-btn" onClick={createTimetable}>✦ Generate timetable</button>
              <button className="secondary-btn" onClick={createTimetable}>↻ Randomize</button>
              <button className="secondary-btn" onClick={saveTimetable} disabled={!plan.length}>Save plan</button>
              <button className="secondary-btn" onClick={testAlarm}>🔔 Test alarm</button>
            </div>
            {planMessage && <p className="plan-message">{planMessage}</p>}
            <p className="helper-text">
              🔔 Alarms ring at the start of every study session, every break, and when the timetable ends.
              Keep this tab open (it can be in the background) and your device awake with the volume up.
            </p>
          </section>

          {plan.length > 0 && (
            <section className="builder-card results-card">
              <div className="results-heading">
                <div>
                  <span className="small-label">YOUR PERSONAL PLAN</span>
                  <h2>Today's study flow 💜</h2>
                </div>
                <button className="secondary-btn" onClick={saveTimetable}>Save</button>
              </div>

              <div className="timeline">
                {plan.map((item, index) => (
                  <div className={`timeline-row ${item.type === 'break' ? 'break-row' : ''}`} key={item.id}>
                    <div className="timeline-time">
                      <strong>{formatTime(item.start)}</strong>
                      <span>{formatTime(item.end)}</span>
                    </div>
                    <div className="timeline-line"><span /></div>
                    <div className="timeline-content">
                      {item.type === 'study' ? (
                        <>
                          <span className="session-type">📚 STUDY SESSION · {item.difficulty.toUpperCase()}</span>
                          <input className="edit-subject" value={item.subject}
                            onChange={(e) => editSession(item.id, e.target.value)}
                            aria-label="Edit session subject" />
                          <span className="session-duration">{item.end - item.start} minutes</span>
                          <div className="session-move">
                           <button onClick={() => moveSession(item.id, -1)}disabled={
                            !plan.slice(0, index).some(
                            (session) => session.type === 'study'
                            )
                            }
                            >
                            ↑ Move up
                            </button>

<button
  onClick={() => moveSession(item.id, 1)}
  disabled={
    !plan.slice(index + 1).some(
      (session) => session.type === 'study'
    )
  }
>
  ↓ Move down
</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="session-type">🌿 RESET TIME</span>
                          <strong>{item.subject}</strong>
                          <span className="session-duration">{item.end - item.start} minutes</span>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <p className="helper-text">Your changes are saved automatically on this device.</p>
            </section>
          )}
          <p className="footer-note">Small steps count. Take a breath, then begin. ♡</p>
        </main>
      </div>
    )
  }

  return (
    <div className="app">
      {nav}
      <main className="hero">
        <div className="tag">✦ YOUR PERSONAL STUDY COMPANION</div>
        <h1>Make time for what<br /><span>matters most.</span></h1>
        <p className="description">
          Your subjects, your schedule, your pace.<br />
          Let us plan your study time while you focus on your goals.
        </p>
        <div className="actions">
          <button
            className="primary-btn"
            onClick={() => {
              setMessage('')
              setPage(currentUser ? 'dashboard' : 'signup')
            }}
          >
            {currentUser ? 'Go to dashboard' : 'Get started'} <span>→</span>
          </button>
          <button className="secondary-btn" onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}>
            Explore features
          </button>
        </div>

        <div className="preview" id="features">
          <div className="preview-header">
            <div><span className="small-label">YOUR SPACE</span><h3>A little more organized ✨</h3></div>
            <span className="status">● READY TO PLAN</span>
          </div>
          <div className="feature-grid">
            <div className="feature-card lavender"><span className="emoji">📚</span><h4>Smart timetable</h4><p>A plan made around your subjects.</p></div>
            <div className="feature-card peach"><span className="emoji">🧠</span><h4>Study assistant</h4><p>Get help with academic doubts.</p></div>
            <div className="feature-card mint"><span className="emoji">☕</span><h4>Mindful breaks</h4><p>Rest, play, and return refreshed.</p></div>
          </div>
        </div>
        <p className="footer-note">A little progress every day adds up. ♡</p>
      </main>
    </div>
  )
}

export default App