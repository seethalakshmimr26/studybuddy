import 'dotenv/config'
import express from 'express'
import rateLimit from 'express-rate-limit'

const PORT = process.env.PORT || 3001
// Your GitHub Pages origin, e.g. https://YOUR-USERNAME.github.io  (no trailing slash, no repo path)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173'
// If GROQ_API_KEY is set we use Groq (free hosted AI). Otherwise we fall back to Ollama.
const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b'

const SYSTEM_PROMPT = `You are StudyBuddy, a study-only AI assistant.

Your purpose is to help students learn, understand subjects, prepare for exams, revise, practice questions, and improve study habits.

You can:
- Explain academic concepts simply.
- Write exam-style answers according to marks.
- Create quizzes and MCQs.
- Explain programming and debug educational code.
- Summarize study notes and create revision plans.
- Give feedback on academic answers.

Rules:
- Only answer requests directly related to studying or education.
- For unrelated requests, reply: "I'm StudyBuddy 📚 I can help only with study-related questions! Ask me about a subject, exam, concept, or study plan."
- For mixed requests, answer only the study-related part.
- Keep answers clear, friendly, and appropriate for students.
- Never claim to know information you do not know.`

const app = express()
app.set('trust proxy', 1) // needed on Render so rate limiting sees the real client IP

// CORS: only your website may call this server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.use(express.json({ limit: '50kb' }))

app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 15, // 15 questions per minute per student
    message: { answer: 'You are asking too fast. Please wait a minute and try again.' },
  })
)

// Health check (also useful to "wake up" a sleeping free server)
app.get('/', (_req, res) => res.send('StudyBuddy AI server is running'))

app.post('/api/study-assistant', async (req, res) => {
  try {
    const { question, history = [] } = req.body

    if (!question?.trim()) {
      return res.status(400).json({ answer: 'Please enter a question.' })
    }
    if (question.length > 2000) {
      return res.status(400).json({ answer: 'Please keep your question under 2000 characters.' })
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history
        .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
        .slice(-10),
      { role: 'user', content: question },
    ]

    let answer
    if (GROQ_API_KEY) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({ model: GROQ_MODEL, messages }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error?.message || 'Groq request failed')
      answer = data.choices[0].message.content
    } else {
      const r = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Ollama request failed')
      answer = data.message.content
    }

    res.json({ answer })
  } catch (error) {
    console.error('StudyBuddy AI error:', error.message)
    res.status(500).json({
      answer: 'The AI is busy right now. Please try again in a minute.',
    })
  }
})

app.listen(PORT, () => {
  console.log(`StudyBuddy AI server running on port ${PORT}`)
})
