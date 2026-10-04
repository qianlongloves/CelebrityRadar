/** 跨页落地目标（switchTab 无法带参：mine → collection 指定初始 Tab） */
let pendingCollectionTab: 'favorites' | 'history' | null = null

export function setPendingCollectionTab(tab: 'favorites' | 'history'): void {
  pendingCollectionTab = tab
}

export function takePendingCollectionTab(): 'favorites' | 'history' | null {
  const t = pendingCollectionTab
  pendingCollectionTab = null
  return t
}
