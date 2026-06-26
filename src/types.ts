export interface AnalyticsStats {
  total_visitors: number;
  bounce_rate: number;
  avg_duration: number;
  active_now: number;
}

export interface ReferrerData {
  source: string;
  visits: number;
}

export interface DeviceData {
  device_type: string;
  pct: number;
}

export interface OSData {
  os_name: string;
  pct: number;
}

export interface TrendDataPoint {
  date_bucket: string;
  clicks: number;
  uniques: number;
  bounce_rate: number;
}
