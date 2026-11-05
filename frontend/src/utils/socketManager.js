let sharedSocket = null
const listeners = new Set()

const notify = () => {
    for (const listener of listeners) {
        listener()
    }
}

export const getSharedSocket = () => sharedSocket

export const setSharedSocket = (socket) => {
    if (sharedSocket === socket) {
        return
    }
    sharedSocket = socket || null
    notify()
}

export const clearSharedSocket = (socket) => {
    if (socket && sharedSocket !== socket) {
        return
    }
    if (sharedSocket === null) {
        return
    }
    sharedSocket = null
    notify()
}

export const subscribeToSharedSocket = (listener) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
