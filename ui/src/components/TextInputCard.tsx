import SendIcon from '@mui/icons-material/Send'
import {
  CircularProgress,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useState } from 'react'
import { useApi } from '../lib/api'


/** Type text → host synthesizes → frames render on the main
 *  PhotorealFace canvas (via the host's existing /ws/musetalk_frames
 *  re-broadcast).
 *
 *  JarvYZ-embedded only — `capabilities.canSynthesize` must be true.
 *  V12Dashboard gates this component. Standalone has no TTS engine
 *  in the wrapper container, so there's nothing to call here. */
export function TextInputCard() {
  const api = useApi()
  const [text, setText] = useState('')
  const [lang, setLang] = useState<'en' | 'de'>('en')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    if (!api.synthesizeText) {
      setError("Host doesn't expose synthesizeText — TextInputCard shouldn't be visible.")
      return
    }
    setError(null)
    setBusy(true)
    try {
      // Result is ignored — the host fires synthesis through its TTS
      // pipeline which dispatches to the wrapper. Frames return via
      // the host's frames WS (subscribed by PhotorealFace).
      await api.synthesizeText(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Type something and JarvYZ will speak it"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <Select
          size="small"
          value={lang}
          onChange={(e) => setLang(e.target.value as 'en' | 'de')}
          disabled={busy}
          sx={{ minWidth: 64 }}
        >
          <MenuItem value="en">en</MenuItem>
          <MenuItem value="de">de</MenuItem>
        </Select>
        <IconButton
          color="primary"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
        >
          {busy ? <CircularProgress size={20} /> : <SendIcon />}
        </IconButton>
      </Stack>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Paper>
  )
}
