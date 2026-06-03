import { Box, CircularProgress, Paper, Typography } from '@mui/material'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useApi } from '../lib/api'


/** Drag-drop a WAV file → opens WS to wrapper's /ws/say → renders the
 *  resulting frames into a preview canvas. Standalone-mode primary use
 *  case (no JarvYZ = no TTS = need a way to test synthesis end-to-end).
 *
 *  Wire format (server → client, binary): 4-byte big-endian frame_idx
 *  | JPG bytes. Then text "done", then close. Same as the wrapper's
 *  /ws/say emits during TTS dispatch. */
export function AudioDropZone() {
  const api = useApi()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framesReceived, setFramesReceived] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => { wsRef.current?.close() }
  }, [])

  const sendWav = async (file: File) => {
    setError(null)
    setBusy(true)
    setFramesReceived(0)
    const buf = await file.arrayBuffer()

    const url = api.sayWsUrl()
    if (!url) {
      setError('No /ws/say URL available — this build runs in a host that does not expose the wrapper directly.')
      setBusy(false)
      return
    }

    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      ws.send(buf)
    }
    ws.onmessage = async (evt) => {
      if (typeof evt.data === 'string') {
        if (evt.data === 'done') {
          setBusy(false)
        } else if (evt.data.startsWith('error:')) {
          setError(evt.data.slice(6).trim())
          setBusy(false)
        }
        return
      }
      if (!(evt.data instanceof ArrayBuffer)) return
      const data = evt.data as ArrayBuffer
      if (data.byteLength < 5) return
      // Skip the 4-byte frame index header; the rest is JPG bytes.
      const jpgBytes = new Uint8Array(data, 4)
      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(new Blob([jpgBytes], { type: 'image/jpeg' }))
      } catch {
        return
      }
      const canvas = canvasRef.current
      if (canvas) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }
        const ctx = canvas.getContext('2d', { alpha: false })
        ctx?.drawImage(bitmap, 0, 0)
      }
      bitmap.close()
      setFramesReceived((n) => n + 1)
    }
    ws.onerror = () => {
      setError('WebSocket error — wrapper unreachable?')
      setBusy(false)
    }
    ws.onclose = () => {
      // setBusy handled by onmessage(done) — onclose is the fallthrough.
      setBusy((b) => b)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const file = files[0]
    if (!file) return
    if (!/wav|audio/i.test(file.type) && !/\.wav$/i.test(file.name)) {
      setError(`'${file.name}' doesn't look like a WAV file`)
      return
    }
    await sendWav(file)
  }

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    void handleFiles(e.dataTransfer.files)
  }

  return (
    <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', gap: 1.5, alignItems: 'center' }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/wav,.wav"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <Box
        onClick={() => !busy && fileInputRef.current?.click()}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        sx={{
          flex: 1,
          minHeight: 60,
          border: '1.5px dashed',
          borderColor: dragOver ? 'primary.main' : 'divider',
          borderRadius: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          cursor: busy ? 'wait' : 'pointer',
          color: dragOver ? 'primary.main' : 'text.secondary',
          bgcolor: dragOver ? 'action.hover' : 'transparent',
          transition: 'all 120ms ease',
          '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
        }}
      >
        {busy ? (
          <>
            <CircularProgress size={18} />
            <Typography variant="body2">Synthesizing… {framesReceived} frames</Typography>
          </>
        ) : (
          <>
            <UploadFileIcon fontSize="small" />
            <Typography variant="body2">
              {dragOver ? 'Release to test' : 'Drop a WAV to test synthesis'}
            </Typography>
            {framesReceived > 0 && (
              <Typography variant="caption" color="text.secondary">
                last run: {framesReceived} frames
              </Typography>
            )}
          </>
        )}
      </Box>
      <Box
        component="canvas"
        ref={canvasRef}
        sx={{
          width: 96,
          height: 96,
          borderRadius: 1,
          bgcolor: '#04060e',
          objectFit: 'contain',
        }}
      />
      {error && (
        <Typography variant="caption" color="error" sx={{ maxWidth: 200 }}>
          {error}
        </Typography>
      )}
    </Paper>
  )
}
