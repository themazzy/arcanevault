import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import CardScanner from '../scanner/CardScanner'

// Stable identities: CardScanner folds both props into handleScan, which the
// auto-scan effect depends on — a new arrow on every render would restart the
// probe loop and the lock-on tracking frame.
const noop = () => {}

export default function ScannerPage() {
  const navigate = useNavigate()
  const handleClose = useCallback(() => navigate(-1), [navigate])

  return <CardScanner onMatch={noop} onClose={handleClose} />
}
