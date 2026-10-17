import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchApartments } from '@/modules/apartments/api'
import { fetchItems, createIncident, uploadIncidentPhoto, cleanupPhotos } from '@/modules/incidents/api'
import type { SvApartment, SvItem, IncidentKind } from '@/lib/database.types'
import { useAuth } from '@/modules/core/store'
import { useI18n } from '@/i18n'
import { friendlyMessage } from '@/lib/errors'
import { ErrorState } from '@/components/ErrorState'
import { resolveMime, isHeicFile } from '@/lib/files'
import { compressImage } from '@/lib/compress'
import { currentDict } from '@/i18n'
import { ArrowLeft, Camera, Video as VideoIcon, X, Loader as Loader2 } from 'lucide-react'

const MAX_FILES = 6
const MAX_FILE_SIZE = 50 * 1024 * 1024

const ACCEPTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ACCEPTED_VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm'])

function isVideoFile(file: File): boolean {
  const mime = resolveMime(file)
  return !!mime && ACCEPTED_VIDEO_MIMES.has(mime)
}

function validateMediaFile(file: File): string | null {
  const mime = resolveMime(file)
  const d = currentDict().incidents
  if (!mime || (!ACCEPTED_IMAGE_MIMES.has(mime) && !ACCEPTED_VIDEO_MIMES.has(mime))) {
    return d.mediaError
  }
  if (file.size > MAX_FILE_SIZE) return d.mediaTooBig
  return null
}

export function IncidentForm({ backTo }: { backTo?: string }) {
  const { t } = useI18n()
  const kinds: { value: IncidentKind; label: string }[] = [
    { value: 'breakdown', label: t.incidents.kindBreakdown },
    { value: 'broken', label: t.incidents.kindBroken },
    { value: 'lost', label: t.incidents.kindLost },
    { value: 'other', label: t.incidents.kindOther },
  ]
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const preselectApt = params.get('apartment') ?? params.get('apt')
  const profile = useAuth((s) => s.profile)
  const [apartments, setApartments] = useState<SvApartment[]>([])
  const [items, setItems] = useState<SvItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [aptId, setAptId] = useState<number | null>(preselectApt ? Number(preselectApt) : null)
  const [itemId, setItemId] = useState<number | null>(null)
  const [freeText, setFreeText] = useState('')
  const [kind, setKind] = useState<IncidentKind>('breakdown')
  const [qty, setQty] = useState('1')
  const [comment, setComment] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [photoPreviews, setPhotoPreviews] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const clientOpIdRef = useRef<string>(crypto.randomUUID())
  const isOnline = navigator.onLine

  const loadReferenceData = () => {
    if (!profile) return
    setLoading(true)
    setLoadError(null)
    Promise.all([fetchApartments(profile.id), fetchItems()])
      .then(([a, i]) => { setApartments(a); setItems(i) })
      .catch((e) => setLoadError(friendlyMessage(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadReferenceData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id])

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (incoming.length === 0) return
    const remaining = MAX_FILES - photos.length
    if (remaining <= 0) {
      setError(t.incidents.mediaTooMany)
      return
    }
    const d = currentDict().incidents
    const valid: File[] = []
    let hadError = false

    for (const file of incoming.slice(0, remaining)) {
      if (isHeicFile(file)) {
        setConverting(true)
        try {
          const converted = await compressImage(file)
          const convertedFile = new File([converted], file.name.replace(/\.(heic|heif)$/i, '.jpg'), { type: 'image/jpeg' })
          if (convertedFile.size > MAX_FILE_SIZE) { setError(d.mediaTooBig); hadError = true; continue }
          valid.push(convertedFile)
        } catch {
          setError(currentDict().heicNotSupported)
          hadError = true
        } finally {
          setConverting(false)
        }
        continue
      }
      const err = validateMediaFile(file)
      if (err) { setError(err); hadError = true; continue }
      valid.push(file)
    }

    if (valid.length > 0) {
      if (!hadError) setError(null)
      setPhotos((prev) => [...prev, ...valid])
      setPhotoPreviews((prev) => [...prev, ...valid.map((f) => URL.createObjectURL(f))])
    }
  }

  const removePhoto = (idx: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== idx))
    setPhotoPreviews((prev) => { URL.revokeObjectURL(prev[idx]); return prev.filter((_, i) => i !== idx) })
  }

  const handleSubmit = async () => {
    if (!aptId) { setError(t.incidents.apartment); return }
    setSubmitting(true); setError(null)
    const photoPaths: string[] = []
    try {
      if (photos.length > 0 && profile) {
        for (const file of photos) photoPaths.push(await uploadIncidentPhoto(profile.id, file))
      }
      await createIncident({
        apartmentId: aptId,
        itemId,
        freeText: freeText.trim() || null,
        kind,
        qty: Number(qty) || 1,
        comment: comment.trim() || null,
        photoPaths,
        clientOpId: clientOpIdRef.current,
      })
      if (backTo) navigate(backTo)
      else navigate('/sv/incidents')
    } catch (e) {
      if (photoPaths.length > 0) {
        await cleanupPhotos(photoPaths).catch(() => {})
      }
      setError(friendlyMessage(e))
    } finally { setSubmitting(false) }
  }

  if (loading) return <div className="px-4 pt-8 text-center text-muted">{t.app.loading}</div>
  if (loadError) return <ErrorState onRetry={loadReferenceData} />

  return (
    <div className="min-h-screen bg-app">
      <div className="bg-surface border-b border-line sticky top-0 z-30">
        <div className="px-4 py-3 flex items-center gap-3">
          <button onClick={() => backTo ? navigate(backTo) : navigate(-1)} className="p-1 -ml-1"><ArrowLeft className="w-5 h-5 text-muted" /></button>
          <h1 className="text-lg font-semibold text-ink">{t.incidents.title}</h1>
        </div>
      </div>
      <div className="px-4 pt-4 pb-[calc(10rem+env(safe-area-inset-bottom,0px))] space-y-4">
        <Field label={t.incidents.apartment}>
          <select value={aptId ?? ''} onChange={(e) => setAptId(e.target.value ? Number(e.target.value) : null)}
            className="w-full bg-surface rounded-xl px-4 py-3 text-sm border border-line focus:border-accent focus:outline-none">
            <option value="">—</option>
            {apartments.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}
          </select>
        </Field>
        <Field label={t.incidents.item}>
          <select value={itemId ?? ''} onChange={(e) => { const v = e.target.value; setItemId(v ? Number(v) : null); if (v) setFreeText('') }}
            className="w-full bg-surface rounded-xl px-4 py-3 text-sm border border-line focus:border-accent focus:outline-none mb-2">
            <option value="">— {t.incidents.freeText} —</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          {!itemId && <input value={freeText} onChange={(e) => setFreeText(e.target.value)} placeholder={t.incidents.freeText}
            className="w-full bg-surface rounded-xl px-4 py-3 text-sm border border-line focus:border-accent focus:outline-none" />}
        </Field>
        <Field label={t.incidents.kind}>
          <div className="grid grid-cols-2 gap-2">
            {kinds.map((k) => (
              <button key={k.value} onClick={() => setKind(k.value)}
                className={`rounded-xl py-2.5 text-sm border transition-colors ${kind === k.value ? 'border-accent bg-accent-soft text-accent font-medium' : 'border-line bg-surface text-muted'}`}>
                {k.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label={t.incidents.qty}>
          <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}
            className="w-full bg-surface rounded-xl px-4 py-3 text-sm border border-line focus:border-accent focus:outline-none" />
        </Field>
        <Field label={t.incidents.comment}>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
            className="w-full bg-surface rounded-xl px-4 py-3 text-sm border border-line focus:border-accent focus:outline-none resize-none" />
        </Field>
        <Field label={t.incidents.photos}>
          <div className="flex gap-2 flex-wrap">
            {photoPreviews.map((src, idx) => {
              const file = photos[idx]
              const isVideo = file ? isVideoFile(file) : false
              return (
                <div key={idx} className="relative w-20 h-20">
                  {isVideo ? (
                    <div className="w-full h-full bg-app rounded-xl border border-line flex items-center justify-center">
                      <VideoIcon className="w-6 h-6 text-muted" />
                    </div>
                  ) : (
                    <img src={src} alt="" className="w-full h-full object-cover rounded-xl" />
                  )}
                  <button onClick={() => removePhoto(idx)} className="absolute -top-1 -right-1 w-5 h-5 bg-bad text-white rounded-full flex items-center justify-center">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )
            })}
            {photos.length < MAX_FILES && isOnline && !converting && (
              <button onClick={() => fileInputRef.current?.click()} className="w-20 h-20 border-2 border-dashed border-line rounded-xl flex items-center justify-center text-muted hover:border-accent">
                <Camera className="w-6 h-6" />
              </button>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*,video/mp4,video/quicktime,video/webm,.mov,.webm,.heic,.heif" multiple onChange={handlePhotoSelect} className="hidden" />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
      </div>
      <div className="fixed bottom-16 left-0 right-0 bg-surface/95 backdrop-blur border-t border-line px-4 pt-3 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] z-30">
        <div className="max-w-lg mx-auto grid grid-cols-2 gap-3">
          <button onClick={() => backTo ? navigate(backTo) : navigate(-1)} className="min-h-[48px] bg-app text-ink rounded-xl px-2 py-3 text-sm font-medium">{t.incidents.cancel}</button>
          <button onClick={handleSubmit} disabled={submitting || converting || !isOnline}
            className="min-h-[48px] bg-accent text-white rounded-xl px-2 py-3 text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {isOnline ? t.incidents.submit : t.errors.needsNetworkAction}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-ink mb-1.5">{label}</label>
      {children}
    </div>
  )
}
