import { create } from 'zustand'

export const useStore = create((set, get) => ({
  sourceDir: null,
  destDir: null,
  photos: {},
  order: [],
  currentId: null,
  scoringProgress: { done: 0, total: 0 },
  history: [],
  currentRoute: '/',
  isScoring: false,
  authSessionExpired: false,
  exportProgress: { done: 0, total: 0 },
  setSourceDir: (dir) => set({ sourceDir: dir }),
  clearPhotos: () => set({
    photos: {},
    order: [],
    currentId: null,
    history: [],
    scoringProgress: { done: 0, total: 0 },
    exportProgress: { done: 0, total: 0 },
    isScoring: false,
  }),
  setDestDir: (dir) => set({ destDir: dir }),
  setCurrentRoute: (route) => set({ currentRoute: route }),

  addPhotos: (photos) => {
    set((state) => {
      const newPhotos = { ...state.photos }
      photos.forEach((p) => { newPhotos[p.id] = p })
      return { photos: newPhotos, order: [...state.order, ...photos.map(p => p.id)] }
    })
  },
  batchSetPhotoDisplayUrls: (updates) => {
    if (!updates.length) return
    set((state) => {
      const next = { ...state.photos }
      let changed = false
      for (const { id, url } of updates) {
        const photo = next[id]
        if (!photo || photo.url === url) continue
        next[id] = { ...photo, url }
        changed = true
      }
      return changed ? { photos: next } : state
    })
  },
  updatePhotoSharpness: (id, sharpness, rank) => {
    set((state) => ({
      photos: { ...state.photos, [id]: { ...state.photos[id], sharpness, rank } }
    }))
  },
  // Batch update all quality scores to avoid per-photo re-renders
  batchUpdateScores: (results) => {
    set((state) => {
      const updated = { ...state.photos }
      for (const r of results) {
        if (updated[r.id]) {
          updated[r.id] = {
            ...updated[r.id],
            sharpness:     r.sharpness,
            overallScore:  r.overall_score,
            rank:          r.rank,
            exposure:      r.exposure,
            noise:         r.noise,
            contrast:      r.contrast,
            subject:       r.subject,
            composition:   r.composition,
            burstGroup:    r.burst_group,
            burstSize:     r.burst_size,
            isBurstBest:   r.is_burst_best,
          }
        }
      }
      return { photos: updated }
    })
  },
  setCurrentId: (id) => set({ currentId: id }),
  makeDecision: (id, decision) => {
    set((state) => {
      const photo = state.photos[id]
      if (!photo) return state
      const prev = photo.decision
      return {
        photos: { ...state.photos, [id]: { ...photo, decision } },
        history: [...state.history, { id, prev }]
      }
    })
  },
  undo: () => {
    set((state) => {
      if (state.history.length === 0) return state
      const last = state.history[state.history.length - 1]
      return {
        photos: { ...state.photos, [last.id]: { ...state.photos[last.id], decision: last.prev } },
        history: state.history.slice(0, -1)
      }
    })
  },
  toggleFlag: (id) => {
    set((state) => ({
      photos: { ...state.photos, [id]: { ...state.photos[id], flagged: !state.photos[id].flagged } }
    }))
  },
  setScoringProgress: (done, total) => set({ scoringProgress: { done, total } }),
  setIsScoring: (scoring) => set({ isScoring: scoring }),
  setAuthSessionExpired: (expired) => set({ authSessionExpired: !!expired }),
  setExportProgress: (done, total) => set({ exportProgress: { done, total } }),
  getKeepCount: () => Object.values(get().photos).filter(p => p.decision === 'keep').length,
  getMaybeCount: () => Object.values(get().photos).filter(p => p.decision === 'maybe').length,
  getRejectCount: () => Object.values(get().photos).filter(p => p.decision === 'reject').length,
  getTotalCount: () => Object.keys(get().photos).length,
}))
