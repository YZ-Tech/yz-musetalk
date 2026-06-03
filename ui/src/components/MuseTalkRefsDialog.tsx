import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { IconBtn } from '../lib/IconBtn'
import { useApi } from '../lib/api'
import { useMusetalkStore } from '../lib/store-context'
import type { RefItem } from '../types'


const THUMB_SIZE = 96


const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}


/** Refs library — listed as a thumb grid, with upload (file picker +
 *  drag/drop), delete, and set-active. Pre-migration this was a Card
 *  inside Settings → Mouth. Post-migration it's a modal opened from
 *  V12Dashboard's settings button — co-located with the dashboard
 *  variant that uses it. */
export function MuseTalkRefsDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const api = useApi()
  const refs = useMusetalkStore((s) => s.musetalk.refs)
  const activeRef = useMusetalkStore((s) => s.musetalk.activeRef)
  const loading = useMusetalkStore((s) => s.musetalk.loading)
  const storeError = useMusetalkStore((s) => s.musetalk.error)
  const setError = useMusetalkStore((s) => s.setError)
  const refreshRefs = useMusetalkStore((s) => s.refreshRefs)
  const setActiveRef = useMusetalkStore((s) => s.setActiveRef)
  const uploadRef = useMusetalkStore((s) => s.uploadRef)
  const deleteRef = useMusetalkStore((s) => s.deleteRef)

  const [busy, setBusy] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  // Refresh when opening so a recently-uploaded ref in another tab
  // shows up. Cheap.
  useEffect(() => {
    if (open) void refreshRefs()
  }, [open, refreshRefs])

  const activate = async (name: string) => {
    if (name === activeRef) return
    setBusy(name)
    await setActiveRef(name)
    setBusy(null)
  }

  const remove = async (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return
    setBusy(name)
    await deleteRef(name)
    setBusy(null)
  }

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy('__upload__')
    try {
      for (const f of Array.from(files)) {
        await uploadRef(f, f.name)
      }
    } finally {
      setBusy(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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
    void upload(e.dataTransfer.files)
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5 }}>
          <span>MuseTalk · References</span>
          <IconBtn
            label="Reference MuseTalk animates for the PhotorealFace dashboard. A short video (5-15s, face-centered, mp4/webm/mov) gives natural head motion and blinks while the mouth lip-syncs; a single image still works but the head stays frozen. Images are resized to 1024px max-dim and re-encoded as JPEG."
            sx={{ color: 'text.secondary' }}
            icon={<InfoOutlinedIcon fontSize="inherit" />}
            tooltipProps={{ slotProps: { tooltip: { sx: { maxWidth: 360 } } } }}
          />
          <Box sx={{ flex: 1 }} />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => upload(e.target.files)}
          />
          <Button
            size="small"
            variant="outlined"
            startIcon={<UploadFileIcon />}
            onClick={() => fileInputRef.current?.click()}
            disabled={busy === '__upload__'}
          >
            {busy === '__upload__' ? 'Uploading…' : 'Upload'}
          </Button>
        </Stack>
      </DialogTitle>
      <DialogContent
        sx={{ position: 'relative' }}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {storeError && (
          <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
            {storeError}
          </Alert>
        )}
        {loading && refs.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : refs.length === 0 ? null : (
          <Box
            sx={{
              display: 'grid',
              gap: 1,
              gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_SIZE}px, 1fr))`,
              mb: 1.5,
            }}
          >
            {refs.map((r) => (
              <RefThumbnail
                key={r.name}
                item={r}
                isActive={r.name === activeRef}
                refUrl={api.refUrl(r.name)}
                busy={busy === r.name}
                onActivate={() => activate(r.name)}
                onDelete={() => remove(r.name)}
              />
            ))}
          </Box>
        )}
        <Box
          onClick={() => fileInputRef.current?.click()}
          sx={{
            border: '1.5px dashed',
            borderColor: dragOver ? 'primary.main' : 'divider',
            borderRadius: 1,
            py: refs.length === 0 ? 3 : 1.5,
            px: 1.5,
            textAlign: 'center',
            cursor: busy === '__upload__' ? 'wait' : 'pointer',
            color: dragOver ? 'primary.main' : 'text.secondary',
            bgcolor: dragOver ? 'action.hover' : 'transparent',
            transition: 'all 120ms ease',
            '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
          }}
        >
          <Typography variant="body2">
            {dragOver
              ? 'Release to upload'
              : refs.length === 0
              ? 'Drop a photo or video here, or click to upload'
              : 'Drop more, or click to upload'}
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          active: <strong>{activeRef || '—'}</strong>
        </Typography>
      </DialogContent>
    </Dialog>
  )
}


function RefThumbnail({
  item,
  isActive,
  refUrl,
  busy,
  onActivate,
  onDelete,
}: {
  item: RefItem
  isActive: boolean
  refUrl: string
  busy: boolean
  onActivate: () => void
  onDelete: () => void
}) {
  const dims = item.width && item.height ? `${item.width}×${item.height}` : 'unknown'
  const duration = item.duration_s ? ` · ${item.duration_s}s` : ''
  return (
    <Tooltip
      arrow
      title={
        <>
          <div><strong>{item.name}</strong></div>
          <div>{dims} · {fmtSize(item.size_bytes)}{duration}</div>
        </>
      }
    >
      <Box
        onClick={busy ? undefined : onActivate}
        sx={{
          position: 'relative',
          aspectRatio: '1 / 1',
          borderRadius: 1,
          overflow: 'hidden',
          cursor: busy ? 'wait' : isActive ? 'default' : 'pointer',
          border: '2px solid',
          borderColor: isActive ? 'primary.main' : 'transparent',
          opacity: busy ? 0.6 : 1,
          '&:hover .delete-btn': isActive ? {} : { opacity: 1 },
        }}
      >
        {item.kind === 'video' ? (
          <Box
            component="video"
            src={refUrl}
            muted loop autoPlay playsInline
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <Box
            component="img"
            src={refUrl}
            alt={item.name}
            sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
        {isActive && (
          <Box sx={{
            position: 'absolute', top: 4, right: 4,
            bgcolor: 'rgba(0,0,0,0.55)', borderRadius: '50%',
            display: 'flex', p: 0.25,
          }}>
            <CheckCircleIcon sx={{ color: 'primary.main', fontSize: 18 }} />
          </Box>
        )}
        {!isActive && (
          <IconButton
            className="delete-btn"
            size="small"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            sx={{
              position: 'absolute', bottom: 2, right: 2,
              bgcolor: 'rgba(0,0,0,0.55)', color: 'white',
              opacity: 0, transition: 'opacity 150ms ease',
              '&:hover': { bgcolor: 'rgba(0,0,0,0.75)' },
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        )}
        {busy && (
          <Box sx={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            bgcolor: 'rgba(0,0,0,0.4)',
          }}>
            <CircularProgress size={24} sx={{ color: 'white' }} />
          </Box>
        )}
      </Box>
    </Tooltip>
  )
}
