/**
 * useAnalyticsSecondary.ts - Compact detection utilities for analytics
 * All patterns preserved, optimized for fast lazy load.
 */

// ==================== DEVICE & OS ====================
// Precompiled regexes for fast per-request matching.

const DEV_PAT = /bot|smart[- ]?tv|playstation|xbox|nintendo|switch|shield|watch|sm[-r]|pebble|fitbit|garmin|fenix|wear ?os|androidwear|ipad|tablet|kindle|silk|playbook|nexus|galaxy tab|tab|mobi|iphone|ipod|android(?!.*tv|tablet)|windows phone|blackberry/i;
const BOT_PAT = /bot|crawl|slurp|spider|bingpreview|facebookexternalhit|yandex|duckduckbot|baiduspider|semrush|ahrefs|gptbot|chatgpt|claude|anthropic|perplexity/i;
const VR_AR_PAT = /oculus|quest|pico|vive|valve index|hololens|magic leap|vision ?pro|apple vision|windows mixed reality|mixed reality|xr/i;

const OS_PAT: Array<[RegExp, string]> = [
    [/Windows NT 10/i, 'Win10/11'], [/Windows NT [6-9]/i, 'Win'], [/Windows NT/i, 'Win'],
    [/ipad|iphone|ipod|ios|cfnet/i, 'iOS'],
    [/mac os|macintosh/i, 'macOS'], [/android/i, 'Android'],
    [/cros/i, 'ChromeOS'], [/ubuntu/i, 'Ubuntu'], [/mint/i, 'Mint'],
    [/pop_os|pop!/i, 'Pop!_OS'], [/debian/i, 'Debian'], [/kali|parrot/i, 'Kali/Parrot'],
    [/fedora/i, 'Fedora'], [/rhel|red ?hat/i, 'RHEL'], [/centos/i, 'CentOS'],
    [/rocky|almalinux|oracle/i, 'EntLinux'], [/arch|manjaro|endeavouros/i, 'Arch'],
    [/opensuse|suse/i, 'SUSE'], [/nixos/i, 'NixOS'], [/gentoo/i, 'Gentoo'],
    [/zorin|elementary|solus|mx|deepin/i, 'DeskLinux'], [/linux/i, 'Linux'],
    [/tizen|webos/i, 'TVOS'], [/freebsd|openbsd|netbsd/i, 'BSD'],
];

const BROWSER_PAT: Array<[RegExp, string]> = [
    [/edg([ea]|ios)?\//i, 'Edge'],
    [/samsungbrowser\//i, 'Samsung'],
    [/opera|opr\/|opios\//i, 'Opera'],
    [/brave\//i, 'Brave'],
    [/vivaldi\//i, 'Vivaldi'],
    [/ucbrowser\//i, 'UC Browser'],
    [/fbav\/|fbios\//i, 'Facebook'],
    [/instagram\//i, 'Instagram'],
    [/threads\//i, 'Threads'],
    [/duckduckgo\//i, 'DuckDuckGo'],
    [/yabrowser\//i, 'Yandex'],
    [/miuibrowser\//i, 'Miui Browser'],
    [/puffin\//i, 'Puffin'],
    [/crios\//i, 'Chrome (iOS)'],
    [/fxios\//i, 'Firefox (iOS)'],
    [/googleapp\//i, 'Google App'],
    [/chrome|chromium/i, 'Chrome'],
    [/safari/i, 'Safari'],
    [/firefox/i, 'Firefox'],
];

export const detectDevice = (userAgent: string): string => {
    const userAgentLower = userAgent.toLowerCase();
    if (BOT_PAT.test(userAgentLower)) return 'bot';
    if (VR_AR_PAT.test(userAgentLower)) return 'vr_ar';
    if (DEV_PAT.test(userAgentLower)) {
        if (/ipad|tablet|kindle|silk|playbook|nexus|galaxy tab|surface|sm-x|sm-t|sm-p/i.test(userAgentLower)) return 'tablet';
        if (/watch|wearable|sm-r|pebble|fitbit|garmin/i.test(userAgentLower)) return 'wearable';
        if (/smart[- ]?tv|hbbtv|roku|webos|tizen|viera|aquos|bravia|firetv|chromecast/i.test(userAgentLower)) return 'smart_tv';
        if (/playstation|xbox|nintendo|switch|shield|steam/i.test(userAgentLower)) return 'console';
        return 'mobile';
    }
    return 'desktop';
};

export const detectOS = (userAgent: string): string => {
    const userAgentLower = userAgent.toLowerCase();
    // Order matters: iOS patterns should match before macOS.
    for (const [re, lbl] of OS_PAT) if (re.test(userAgentLower)) return lbl;
    return 'Other';
};

export const detectBrowser = (userAgent: string): string => {
    const userAgentLower = userAgent.toLowerCase();
    for (const [re, lbl] of BROWSER_PAT) if (re.test(userAgentLower)) return lbl;
    return 'Other';
};

// ==================== REFERRER SOURCES ====================

// Social platforms
const SOC = [
    'facebook|FB', 'instagram|IG', 'twitter.com|X', 'x.com|X', 't.co|X', 'linkedin|LI',
    'tiktok|TT', 'pinterest|Pin', 'reddit|Reddit', 'threads.net|Threads',
    'youtube.com|YT', 'youtu.be|YT', 'twitch|Twitch', 'vimeo|Vimeo',
    'mastodon|Mastodon', 'bsky.app|Bluesky', 'bsky.social|Bluesky',
    'vk.com|VK', 'weibo|Weibo', 'bilibili|Bili', 'zhihu|Zhihu',
    'quora|Quora', 'tumblr|Tumblr', 'behance|Behance',
    'dribbble|Dribbble', 'stackoverflow|SO', 'github|GitHub',
    'medium|Medium', 'producthunt|PH', 'discord|Discord', 'discordapp|Discord', 'discord.gg|Discord', 'dailymotion|DM', 'douyin|Douyin', 'xiaohongshu|XHS',
    'truthsocial|Truth', 'dev.to|Dev', 'hashnode|Hash',
    'hn.algolia|HN', 'news.ycombinator|HN', 'fosstodon|Mastodon',
    'techhub.social|Mastodon',
];

// Messaging apps
const MSG = [
    'wa.me|WA', 'whatsapp.com|WA', 't.me|TG', 'telegram.org|TG', 'telegram.me|TG',
    'messenger|FB', 'signal|Sig', 'threema|Threema', 'wire|Wire', 'element.io|Element',
    'matrix|Matrix', 'teams.ms|Teams', 'teams.live|Teams', 'skype|Skype',
    'web.skype|Skype', 'slack|Slack', 'kakao.com|Kakao', 'kakaotalk|Kakao',
    'line.me|LINE', 'naver.jp|LINE', 'viber|Viber', 'wechat|WeChat',
    'qq.com|QQ', 'weixin.qq|WeChat', 'snapchat|Snap', 'kik|Kik', 'zoom|Zoom',
    'chat.google|GChat', 'hangouts|Hangouts', 'messages.google|GMsg',
];

// Email providers
const EMAIL = [
    'mail.google.com|Gmail', 'gmail.com|Gmail', 'outlook.live|Outlook',
    'outlook.office|Outlook', 'outlook.com|Outlook', 'hotmail.com|Outlook',
    'live.com|Outlook', 'office.com|Outlook', 'office365|Outlook',
    'mail.yahoo|Yahoo', 'yahoo.com|Yahoo', 'ymail|Yahoo', 'rocketmail|Yahoo',
    'aol.com|AOL', 'mail.aol|AOL',
    'proton.me|Proton', 'protonmail.com|Proton', 'tutanota|Tuta',
    'tuta.com|Tuta', 'mailbox.org|Mailbox', 'posteo.de|Posteo',
    'runbox|Runbox', 'countermail|Counter', 'icloud.com|iCloud',
    'me.com|iCloud', 'mac.com|iCloud', 'hey.com|Hey', 'hey.science|Hey',
    'fastmail|Fastmail', 'gmx.com|GMX', 'gmx.de|GMX', 'gmx.net|GMX',
    'gmx.co.uk|GMX', 'web.de|Webde', 't-online.de|TOnline',
    'freenet|Freenet', 'mail.de|Mailde',
    'mail.ru|Mailru', 'yandex.ru|Yandex', 'yandex.com|Yandex',
    'inbox.ru|Mailru', 'list.ru|Mailru', 'bk.ru|Mailru',
    'mail.qq.com|QQ', 'qq.com|QQ', '163.com|163', '126.com|126',
    'yeah.net|Yeah', 'naver.com|Naver', 'hanmail.net|Daum', 'daum.net|Daum',
    'zoho.com|Zoho', 'zoho.eu|Zoho', 'comcast|Comcast', 'xfinity|Comcast',
    'verizon|Verizon', 'sbcglobal|AT&T', 'bellsouth|AT&T', 'att.net|AT&T',
    'charter|Spectrum', 'spectrum.net|Spectrum', 'cox.net|Cox',
    'earthlink|Earthlink',
];

// Search engines
const SCH = [
    'google.|Google', 'bing|Bing', 'yahoo|Yahoo', 'yahoo.co.jp|Yahoo',
    'duckduckgo|DDG', 'baidu|Baidu', 'yandex|Yandex', 'ecosia|Ecosia',
    'ask|Ask', 'aol|AOL', 'naver|Naver', 'daum|Daum',
    'seznam|Seznam', 'qwant|Qwant', 'startpage|Startpage', 'brave|Brave',
];

// Normalize helpers - only strip common second-level TLDs, not standalone TLDs like .io, .app
const norm = (s: string) => s.replace(/^www\./, '').replace(/\.(com|net|org|co)$/i, '').trim();

const SECOND_LEVEL_TLDS = new Set(['co', 'net', 'org', 'gov', 'edu', 'ac']);
// NOTE: 'com' is a TLD, not second-level. Removed to prevent incorrect referrer attribution.

const matchesHost = (host: string, needleRaw: string): boolean => {
    const needle = needleRaw.replace(/\.$/, '').toLowerCase();
    if (!needle) return false;
    if (host === needle || host.endsWith('.' + needle)) return true;
    if (needle.includes('.')) return false;

    const labels = host.split('.');
    if (labels.length >= 2 && labels[labels.length - 2] === needle) return true;
    if (
        labels.length >= 3 &&
        SECOND_LEVEL_TLDS.has(labels[labels.length - 2]) &&
        labels[labels.length - 3] === needle
    ) return true;

    return false;
};

// Fast matcher for lists shaped as ["needle|Label", ...]
const findSrc = (host: string, list: string[]): string | null => {
    for (const entry of list) {
        const sep = entry.indexOf('|');
        const needle = sep >= 0 ? entry.slice(0, sep) : entry;
        const label = sep >= 0 ? entry.slice(sep + 1) : entry;
        if (matchesHost(host, needle)) {
            return label;
        }
    }
    return null;
};

export interface ReferrerInfo {
    source: string;
    category: 'Social' | 'Messaging' | 'Email' | 'Search' | 'Direct' | 'UTM' | 'App' | 'Other';
}

export const parseReferrerSource = (referrer: string | null): ReferrerInfo => {
    if (!referrer) return { source: 'Direct', category: 'Direct' };
    try {
        const lower = referrer.toLowerCase();
        if (lower.startsWith('about:')) return { source: 'Direct', category: 'Direct' };
        if (lower.startsWith('mailto:')) return { source: 'Email', category: 'Email' };
        if (lower.startsWith('sms:') || lower.startsWith('mms:')) return { source: 'SMS', category: 'Messaging' };
        if (lower.startsWith('tel:')) return { source: 'Phone', category: 'Messaging' };
        if (lower.startsWith('android-app://')) return { source: 'Android App', category: 'App' };
        if (lower.startsWith('ios-app://')) return { source: 'iOS App', category: 'App' };
        if (lower.includes('app-id=') || lower.includes('app_id=')) return { source: 'iOS App', category: 'App' };

        const url = new URL(referrer);
        const host = url.hostname.toLowerCase();
        const utm = url.searchParams.get('utm_source');
        if (utm) return { source: norm(utm), category: 'UTM' };

        let src = findSrc(host, EMAIL);
        if (src) return { source: src, category: 'Email' };

        src = findSrc(host, MSG);
        if (src) return { source: src, category: 'Messaging' };

        src = findSrc(host, SOC);
        if (src) return { source: src, category: 'Social' };

        src = findSrc(host, SCH);
        if (src) return { source: src, category: 'Search' };

        return { source: norm(host) || 'Other', category: 'Other' };
    } catch {
        return { source: 'Other', category: 'Other' };
    }
};
