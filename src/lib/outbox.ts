import { get, update, set as idbSet } from 'idb-keyval'
import { supabase } from '@/lib/supabase'
import { toApiError } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { currentDict } from '@/i18n'
import { resolveMime, extForMime } from '@/lib/files'

export type MediaStatus = 'none' | 'pending' | 'failed'

export interface OutboxEntry {
  id: string
  userId: string
  apartmentId: number
  cleanedAt: string
  clientOpId: string
  staffIds: number[]
  leadStaffId: number | null
  note: string | null
  createdAt: number
  status: 'pending' | 'done' | 'failed'
  lastError: string | null
  attempts: number
  mediaStatus: MediaStatus
  mediaAttempts: number
  mediaError: string | null
}

const OUTBOX_KEY = 'cleaning-outbox'
const MEDIA_KEY_PREFIX = 'cleaning-media-blobs:'
const MAX_ATTEMPTS = 20
const MAX_MEDIA_ATTEMPTS = 10

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
  for (const l of listeners) l()
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function mediaKey(entryId: string): string {
  return `${MEDIA_KEY_PREFIX}${entryId}`
}

async function storeMediaBlobs(entryId: string, blobs: Blob[]): Promise<void> {
  await idbSet(mediaKey(entryId), blobs)
}

async function getMediaBlobs(entryId: string): Promise<Blob[] | null> {
  return await get<Blob[]>(mediaKey(entryId))
}

async function removeMediaBlobs(entryId: string): Promise<void> {
  await idbSet(mediaKey(entryId), null)
}

export async function getOutboxSummary(userId: string): Promise<{ pending: number; failed: number; mediaFailed: number; mediaPending: number }> {
  const all = (await get<OutboxEntry[]>(OUTBOX_KEY)) ?? []
  const mine = all.filter((e) => e.userId === userId)
  return {
    pending: mine.filter((e) => e.status === 'pending').length,
    failed: mine.filter((e) => e.status === 'failed').length,
    mediaFailed: mine.filter((e) => e.mediaStatus === 'failed').length,
    mediaPending: mine.filter((e) => e.mediaStatus === 'pending').length,
  }
}

export async function getOutboxEntries(userId: string): Promise<OutboxEntry[]> {
  const all = (await get<OutboxEntry[]>(OUTBOX_KEY)) ?? []
  return all.filter((e) => e.userId === userId).sort((a, b) => a.createdAt - b.createdAt)
}

export async function addOutboxEntry(entry: Omit<OutboxEntry, 'status' | 'lastError' | 'attempts' | 'mediaStatus' | 'mediaAttempts' | 'mediaError'> & { media?: Blob[] }): Promise<void> {
  const hasMedia = !!(entry.media && entry.media.length > 0)
  const full: OutboxEntry = {
    id: entry.id,
    userId: entry.userId,
    apartmentId: entry.apartmentId,
    cleanedAt: entry.cleanedAt,
    clientOpId: entry.clientOpId,
    staffIds: entry.staffIds,
    leadStaffId: entry.leadStaffId,
    note: entry.note,
    createdAt: entry.createdAt,
    status: 'pending',
    lastError: null,
    attempts: 0,
    mediaStatus: hasMedia ? 'pending' : 'none',
    mediaAttempts: 0,
    mediaError: null,
  }
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) => [...(existing ?? []), full])
  if (hasMedia && entry.media) {
    await storeMediaBlobs(full.id, entry.media)
  }
  notify()
}

async function removeOutboxEntry(id: string): Promise<void> {
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) =>
    (existing ?? []).filter((e) => e.id !== id),
  )
  await removeMediaBlobs(id)
  notify()
}

export async function deleteFailedEntry(id: string): Promise<void> {
  await removeOutboxEntry(id)
}

export async function retryFailedEntry(id: string): Promise<void> {
  await updateOutboxEntry(id, (e) => {
    e.status = 'pending'
    e.attempts = 0
    e.lastError = null
  })
  notify()
}

export async function retryMediaEntry(id: string): Promise<void> {
  await updateOutboxEntry(id, (e) => {
    e.mediaStatus = 'pending'
    e.mediaAttempts = 0
    e.mediaError = null
  })
  notify()
}

async function updateOutboxEntry(id: string, mutate: (e: OutboxEntry) => void): Promise<void> {
  await update<OutboxEntry[]>(OUTBOX_KEY, (existing) => {
    const list = existing ?? []
    const idx = list.findIndex((e) => e.id === id)
    if (idx === -1) return list
    mutate(list[idx])
    return list
  })
}

async function uploadMediaForEntry(entry: OutboxEntry): Promise<void> {
  const blobs = await getMediaBlobs(entry.id)
  if (!blobs || blobs.length === 0) {
    await updateOutboxEntry(entry.id, (e) => { e.mediaStatus = 'none' })
    return
  }

  const paths: string[] = []
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i]
    const mime = resolveMime(blob as File) ?? 'application/octet-stream'
    const ext = extForMime(mime)
    const path = `${entry.userId}/${entry.clientOpId}/${i}${ext}`
    const { error } = await supabase.storage
      .from('cleaning-media')
      .upload(path, blob, { contentType: mime, upsert: true })
    if (error) throw toApiError(error)
    paths.push(path)
  }

  const { error: rpcError } = await supabase.rpc('attach_cleaning_media', {
    p_client_op_id: entry.clientOpId,
    p_paths: paths,
  })
  if (rpcError) throw toApiError(rpcError)

  await removeMediaBlobs(entry.id)
  await updateOutboxEntry(entry.id, (e) => {
    e.mediaStatus = 'none'
    e.mediaError = null
  })
}

let flushInProgress = false

export async function flushOutbox(userId: string): Promise<void> {
  if (flushInProgress) return
  flushInProgress = true
  try {
    const entries = await getOutboxEntries(userId)
    let anySynced = false

    for (const entry of entries) {
      if (entry.status === 'failed') continue

      let currentStatus = entry.status

      if (currentStatus === 'pending') {
        const { error, status } = await supabase.rpc('complete_cleaning', {
          p_apartment_id: entry.apartmentId,
          p_cleaned_at: entry.cleanedAt,
          p_client_op_id: entry.clientOpId,
          p_staff_ids: entry.staffIds,
          p_lead_staff_id: entry.leadStaffId,
          p_note: entry.note,
        })

        if (!error) {
          await updateOutboxEntry(entry.id, (e) => { e.status = 'done'; e.lastError = null })
          currentStatus = 'done'
          anySynced = true
        } else {
          const apiError = toApiError(error, status)

          if (apiError.code === '23505') {
            await updateOutboxEntry(entry.id, (e) => { e.status = 'done'; e.lastError = null })
            currentStatus = 'done'
            anySynced = true
          } else if (apiError.isAuth) {
            await updateOutboxEntry(entry.id, (e) => {
              e.attempts += 1
              e.lastError = apiError.message
            })
            notify()
            const { data: { session } } = await supabase.auth.refreshSession()
            if (!session) {
              toast(currentDict().errors.auth, 'error')
            }
            break
          } else if (apiError.status != null && apiError.status >= 500) {
            const newAttempts = entry.attempts + 1
            if (newAttempts >= MAX_ATTEMPTS) {
              await updateOutboxEntry(entry.id, (e) => {
                e.status = 'failed'
                e.lastError = apiError.message
                e.attempts = newAttempts
              })
            } else {
              await updateOutboxEntry(entry.id, (e) => {
                e.attempts = newAttempts
                e.lastError = apiError.message
              })
            }
            notify()
            break
          } else if (apiError.isNetwork) {
            await updateOutboxEntry(entry.id, (e) => {
              e.attempts += 1
              e.lastError = apiError.message
            })
            notify()
            break
          } else if (apiError.code && (apiError.status == null || apiError.status < 500)) {
            await updateOutboxEntry(entry.id, (e) => {
              e.status = 'failed'
              e.lastError = apiError.message
            })
            notify()
            continue
          } else {
            const newAttempts = entry.attempts + 1
            if (newAttempts >= MAX_ATTEMPTS) {
              await updateOutboxEntry(entry.id, (e) => {
                e.status = 'failed'
                e.lastError = apiError.message
                e.attempts = newAttempts
              })
            } else {
              await updateOutboxEntry(entry.id, (e) => {
                e.attempts = newAttempts
                e.lastError = apiError.message
              })
            }
            notify()
            continue
          }
        }
      }

      if (entry.mediaStatus === 'pending' && currentStatus === 'done') {
        try {
          await uploadMediaForEntry(entry)
          notify()
        } catch (mediaErr) {
          const apiError = toApiError(mediaErr)
          const newMediaAttempts = entry.mediaAttempts + 1
          if (apiError.isNetwork || (apiError.status != null && apiError.status >= 500)) {
            if (newMediaAttempts >= MAX_MEDIA_ATTEMPTS) {
              await updateOutboxEntry(entry.id, (e) => {
                e.mediaStatus = 'failed'
                e.mediaError = apiError.message
                e.mediaAttempts = newMediaAttempts
              })
            } else {
              await updateOutboxEntry(entry.id, (e) => {
                e.mediaAttempts = newMediaAttempts
                e.mediaError = apiError.message
              })
            }
          } else {
            await updateOutboxEntry(entry.id, (e) => {
              e.mediaStatus = 'failed'
              e.mediaError = apiError.message
              e.mediaAttempts = newMediaAttempts
            })
          }
          notify()
          if (apiError.isNetwork) break
        }
      }

      const current = (await getOutboxEntries(userId)).find((e) => e.id === entry.id)
      if (current && current.status === 'done' && current.mediaStatus === 'none') {
        await removeOutboxEntry(entry.id)
        anySynced = true
      }
    }

    if (anySynced) {
      const d = currentDict()
      toast(d.errors.outboxSynced, 'success')
    }
  } finally {
    flushInProgress = false
    notify()
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null
let onlineHandler: (() => void) | null = null
let visibleHandler: (() => void) | null = null

export function startOutboxSync(userId: string): void {
  stopOutboxSync()

  flushOutbox(userId).catch(() => {})

  onlineHandler = () => flushOutbox(userId).catch(() => {})
  visibleHandler = () => {
    if (document.visibilityState === 'visible') flushOutbox(userId).catch(() => {})
  }

  window.addEventListener('online', onlineHandler)
  document.addEventListener('visibilitychange', visibleHandler)

  intervalId = setInterval(async () => {
    const summary = await getOutboxSummary(userId)
    if (summary.pending > 0 || summary.mediaFailed > 0 || summary.mediaPending > 0) {
      flushOutbox(userId).catch(() => {})
    }
  }, 30000)
}

export function stopOutboxSync(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler)
    onlineHandler = null
  }
  if (visibleHandler) {
    document.removeEventListener('visibilitychange', visibleHandler)
    visibleHandler = null
  }
}
