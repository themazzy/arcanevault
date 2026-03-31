import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import CardScanner from '../scanner/CardScanner'
import AddCardModal from '../components/AddCardModal'
import { useAuth } from '../components/Auth'

export default function ScannerPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [addCard, setAddCard] = useState(null)  // { name, ... } from hash match

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
