import { useNavigate } from 'react-router-dom'
import CardScanner from '../scanner/CardScanner'

export default function ScannerPage() {
  const navigate = useNavigate()
  return <CardScanner onMatch={() => {}} onClose={() => navigate(-1)} />
}
