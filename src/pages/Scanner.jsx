import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CardScanner from '../scanner/CardScanner'
import { useAuth } from '../components/Auth'
import { sb } from '../lib/supabase'
import styles from './Scanner.module.css'

export default function ScannerPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [matchedCard, setMatchedCard] = useState(null)
  const [added, setAdded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  const handleMatch = (card) => {
    setMatchedCard(card)
    setAdded(false)
  }

  const handleClose = () => {
    navigate(-1)
  }

  return (
    <div className={styles.page}>
      <CardScanner onMatch={handleMatch} onClose={handleClose} />
      {toast && (
        <div className={`${styles.toast} ${toast.ok ? styles.toastOk : styles.toastErr}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
