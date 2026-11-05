import { useSyncExternalStore } from 'react'
import { getSharedSocket, subscribeToSharedSocket } from '../utils/socketManager'

function useSocket() {
    return useSyncExternalStore(subscribeToSharedSocket, getSharedSocket, getSharedSocket)
}

export default useSocket
