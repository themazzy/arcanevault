import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import CardScanner from '../scanner/CardScanner'
import AddCardModal from '../components/AddCardModal'
import { useAuth } from '../components/Auth'
import styles from './Scanner.module.css'

export default function ScannerPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isNative = Capacitor.isNativePlatform()
  const [addCard, setAddCard] = useState(null)  // { name, ... } from hash match

  if (!isNative) {
    return (
      <section className={styles.webGate}>
        <div className={styles.webGatePanel}>
          <span className={styles.webGateEyebrow}>App exclusive</span>
          <h1 className={styles.webGateTitle}>Scanner is only available in the Android app.</h1>
          <p className={styles.webGateBody}>
            Use ArcaneVault on your phone to scan cards with the camera and add them straight to your collection.
          </p>
          <div className={styles.webGateActions}>
            <a className={styles.primaryAction} href="/" onClick={event => { event.preventDefault(); navigate('/') }}>
              Back to Home
            </a>
            <span className={styles.placeholderBadge} aria-label="Google Play badge placeholder">
              Google Play badge coming soon
            </span>
          </div>
          <p className={styles.webGateNote}>
            Google Play listing is not live yet. Replace this placeholder with the real store badge once the app is published.
          </p>
        </div>
      </section>
    )
  }

  return (
    <>
      <CardScanner
        onMatch={() => {}}
        onAddCard={card => setAddCard(card)}
        onClose={() => navigate(-1)}
      />
      {addCard && (
        <AddCardModal
          userId={user?.id}
          initialCardName={addCard.name}
          onClose={() => setAddCard(null)}
          onSaved={() => setAddCard(null)}
        />
      )}
    </>
  )
}
