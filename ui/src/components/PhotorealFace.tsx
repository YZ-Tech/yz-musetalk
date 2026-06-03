import FullscreenIcon from '@mui/icons-material/Fullscreen'
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit'
import { Box, Paper, Stack, Typography } from '@mui/material'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconBtn } from '../lib/IconBtn'
import { useApi } from '../lib/api'
import { useMusetalkStore } from '../lib/store-context'


/** PhotorealFace — connects to the wrapper's frame WS and renders the
 *  JPG stream into a canvas. When idle, the reference still photo /
 *  loop video shows through as a backdrop.
 *
 *  Wire format (server → client, binary frames):
 *      4-byte big-endian frame_idx | JPG bytes
 *  Same shape as the wrapper's /ws/say output (JarvYZ re-broadcasts
 *  verbatim on /ws/musetalk_frames; standalone connects directly).
 *
 *  `topRightActions` slot is where V12Dashboard injects its settings-
 *  open button next to the fullscreen control. */

const IDLE_THRESHOLD_MS = 400
const FADE_MS = 160
const FPS = 25
const FRAME_MS = 1000 / FPS
const LATE_REBASE_MS = 200


export interface PhotorealFaceProps {
  topRightActions?: ReactNode
}


export function PhotorealFace({ topRightActions }: PhotorealFaceProps) {
  const api = useApi()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [status, setStatus] = useState<'connecting' | 'idle' | 'streaming' | 'closed'>('connecting')
  const [fps, setFps] = useState(0)
  const lastFrameAt = useRef<number>(0)

  // Active ref is the satellite-store's source of truth (populated by
  // refreshRefs from the api.list() call; updated by setActiveRef).
  const activeRef = useMusetalkStore((s) => s.musetalk.activeRef) ?? 'megan.jpg'
  const referenceImageUrl = api.refUrl(activeRef)
  const isVideoRef = /\.(mp4|webm|mov|mkv)$/i.test(activeRef)

  const fpsCounterRef = useRef<{ count: number; t0: number }>({ count: 0, t0: 0 })
  const anchorRef = useRef<{ t0: number; baseIdx: number } | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      const url = api.framesWsUrl()
      if (!url) return
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        if (cancelled) return
        setStatus('idle')
      }
      ws.onmessage = async (evt) => {
        if (!(evt.data instanceof ArrayBuffer)) return
        const buf = evt.data as ArrayBuffer
        if (buf.byteLength < 5) return
        const view = new DataView(buf, 0, 4)
        const frameIdx = view.getUint32(0, false)
        const jpgBytes = new Uint8Array(buf, 4)
        let bitmap: ImageBitmap
        try {
          bitmap = await createImageBitmap(new Blob([jpgBytes], { type: 'image/jpeg' }))
        } catch {
          return
        }

        const now = performance.now()
        if (anchorRef.current === null) {
          anchorRef.current = { t0: now, baseIdx: frameIdx }
        }
        const anchor = anchorRef.current
        let scheduled = anchor.t0 + (frameIdx - anchor.baseIdx) * FRAME_MS

        if (now - scheduled > LATE_REBASE_MS) {
          anchorRef.current = { t0: now, baseIdx: frameIdx }
          scheduled = now
        }

        const draw = () => {
          const canvas = canvasRef.current
          if (!canvas) {
            bitmap.close()
            return
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          const ctx = canvas.getContext('2d', { alpha: false })
          ctx?.drawImage(bitmap, 0, 0)
          bitmap.close()
          lastFrameAt.current = performance.now()
          setStatus('streaming')
          const fc = fpsCounterRef.current
          fc.count += 1
          const t = performance.now()
          if (fc.t0 === 0) fc.t0 = t
          if (t - fc.t0 >= 1000) {
            setFps(Math.round((fc.count * 1000) / (t - fc.t0)))
            fc.count = 0
            fc.t0 = t
          }
        }
        const delay = Math.max(0, scheduled - now)
        if (delay === 0) draw()
        else setTimeout(draw, delay)
      }
      ws.onclose = () => {
        if (cancelled) return
        setStatus('closed')
        reconnectTimer = setTimeout(connect, 1500)
      }
      ws.onerror = () => { /* onclose follows */ }
    }

    connect()

    const idleTimer = setInterval(() => {
      if (lastFrameAt.current && performance.now() - lastFrameAt.current > IDLE_THRESHOLD_MS) {
        setStatus((s) => (s === 'streaming' ? 'idle' : s))
        setFps(0)
        fpsCounterRef.current = { count: 0, t0: 0 }
        anchorRef.current = null
      }
    }, 200)

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(idleTimer)
      ws?.close()
    }
  }, [api])

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      containerRef.current?.requestFullscreen()
    }
  }

  return (
    <Paper
      ref={containerRef}
      sx={{
        p: 0,
        bgcolor: '#04060e',
        borderRadius: isFullscreen ? 0 : 2,
        overflow: 'hidden',
        position: 'relative',
        height: isFullscreen ? '100vh' : 'auto',
      }}
    >
      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: isFullscreen
            ? '100vh'
            : { xs: 'calc(100dvh - 200px)', md: 'calc(100dvh - 120px)' },
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isVideoRef ? (
          <Box
            component="video"
            src={referenceImageUrl}
            autoPlay
            loop
            muted
            playsInline
            sx={{ position: 'absolute', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <Box
            component="img"
            src={referenceImageUrl}
            alt=""
            sx={{ position: 'absolute', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        )}
        <Box
          component="canvas"
          ref={canvasRef}
          sx={{
            position: 'absolute',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            opacity: status === 'streaming' ? 1 : 0,
            transition: `opacity ${FADE_MS}ms ease`,
          }}
        />
      </Box>

      <Box
        sx={{
          position: 'absolute', bottom: 8, left: 8,
          bgcolor: 'rgba(4, 6, 14, 0.55)', backdropFilter: 'blur(6px)',
          borderRadius: 1, px: 1, py: 0.25,
          opacity: 0.5, transition: 'opacity 180ms ease',
          '&:hover': { opacity: 1 },
        }}
      >
        <Typography variant="caption" sx={{ color: '#cfd6e6', fontFamily: 'ui-monospace, monospace' }}>
          {status === 'streaming' ? `streaming · ${fps} fps` : status}
        </Typography>
      </Box>

      <Stack
        direction="row"
        spacing={0.5}
        sx={{
          position: 'absolute', top: 8, right: 8,
          bgcolor: 'rgba(4, 6, 14, 0.55)', backdropFilter: 'blur(6px)',
          borderRadius: 1, p: 0.25,
          opacity: 0, transition: 'opacity 180ms ease',
          '&:hover': { opacity: 1 },
        }}
      >
        {topRightActions}
        <IconBtn
          label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={toggleFullscreen}
          sx={{ color: '#cfd6e6' }}
          icon={isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
        />
      </Stack>
    </Paper>
  )
}
