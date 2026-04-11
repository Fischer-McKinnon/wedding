// Shared types for the seating chart.

export type RGGuest = {
  id: string
  name: string
  householdId: string
  isPrimary: boolean
  attending: string
  welcomeDinner: boolean
  boatTransfer: boolean
  ceremony: boolean
  brunch: boolean
  entree: string
  hotel: string
  allergy: string
  email: string
  phone: string
  address: string
  rsvpdOn: string
}

export type SeatingTable = {
  id: string
  number: number
  name: string
  capacity: number
}
