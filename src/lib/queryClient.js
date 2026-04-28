import { QueryClient } from '@tanstack/react-query'
import { isNetworkLikeError } from './networkUtils'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      networkMode: 'offlineFirst',
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (count, error) => count < 2 && !isNetworkLikeError(error),
    },
  },
})
