import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { History as HistoryIcon, Wrench, RefreshCw } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useAuth } from '@/modules/core/store'
import { CleaningHistoryList } from '@/modules/history/CleaningHistoryList'
import { IncidentHistoryList } from '@/modules/history/IncidentHistoryList'
import { fetchApartments } from '@/modules/apartments/api'
import { friendlyMessage } from '@/lib/errors'
import { ErrorState } from '@/components/ErrorState'
import type { SvApartment } from '@/lib/database.types'

type Tab = 'cleaning' | 'incidents'

export function QrHistoryPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const profile = useAuth((s) => s.profile)
  const aptId = id ? Number(id) : undefined
  const [apartment, setApartment] = useState<SvApartment | null>(null)
  const [tab, setTab] = useState<Tab>('cleaning')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (!aptId || !profile) return
    setLoading(true)
    setError(null)
    fetchApartments(profile.id)
      .then((all) => {
        const apt = all.find((a) => a.id === aptId)
        if (apt) setApartment(apt)
      })
      .catch((e) => {
        if (friendlyMessage(e) === t.errors.network) {
          setOffline(true)
        } else {
          setError(friendlyMessage(e))
        }
      })
      .finally(() => setLoading(false))
  }, [aptId])

  const handleRetry = () => {
    if (!aptId || !profile) return
    setOffline(false)
    setError(null)
    setLoading(true)
    fetchApartments(profile.id)
      .then((all) => {
        const apt = all.find((a) => a.id === aptId)
        if (apt) setApartment(apt)
      })
      .catch((e) => {
        if (friendlyMessage(e) === t.errors.network) {
          setOffline(true)
        } else {
          setError(friendlyMessage(e))
        }
      })
      .finally(() => setLoading(false))
  }

  if (loading) {
    return <div className="px-4 pt-8 text-center text-muted">{t.app.loading}</div>
  }

  if (offline) {
    return (
      <div className="px-4 pt-8 text-center">
        <p className="text-sm text-muted mb-4">{t.qr.historyOffline}</p>
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-2 bg-accent text-white rounded-xl px-5 py-2.5 text-sm font-medium"
        >
          <RefreshCw className="w-4 h-4" />
          {t.retry}
        </button>
      </div>
    )
  }

  if (error) {
    return <ErrorState onRetry={handleRetry} />
  }

  return (
    <div className="px-4 pt-4 pb-28">
      {apartment && (
        <div className="mb-4">
          <h1 className="text-lg font-semibold text-ink">{apartment.code}</h1>
          <p className="text-xs text-muted">{apartment.building}</p>
        </div>
      )}

      <div className="flex gap-1 mb-4 border-b border-line">
        <TabButton active={tab === 'cleaning'} onClick={() => setTab('cleaning')} icon={HistoryIcon} label={t.history.cleaningTab} />
        <TabButton active={tab === 'incidents'} onClick={() => setTab('incidents')} icon={Wrench} label={t.history.incidentsTab} />
      </div>

      {tab === 'cleaning' && <CleaningHistoryList apartmentId={aptId} canDelete={false} />}
      {tab === 'incidents' && <IncidentHistoryList apartmentId={aptId} canDelete={false} />}
    </div>
  )
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 transition-colors ${active ? 'border-accent text-accent font-medium' : 'border-transparent text-muted'}`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  )
}
