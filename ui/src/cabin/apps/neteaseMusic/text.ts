import type { Strings } from '../../state/strings'
import { useText as useCabinText } from '../../state/text'

export { useLanguage } from '../../state/text'

/**
 * The copied Music app's words, in the cab's Chinese: NetEase Cloud Music's name, its sign-in, the
 * short note while a VIP song plays as its 30 seconds, and what the pages call things. The layout,
 * pages and animations stay Apple Music's.
 */
export function useText(): Strings {
  const text = useCabinText()
  return {
    ...text,
    appleMusic: {
      ...text.appleMusic,
      tabs: { home: '首页', new: '最新', radio: '榜单', library: '我的音乐', search: '搜索' },
      searchHint: '搜索歌曲、歌手、专辑或歌单',
      browseCategories: '分类歌单',
      recentlySearched: '最近搜索',
      topResults: '最佳结果',
      songs: '歌曲',
      artists: '歌手',
      albums: '专辑',
      playlists: '歌单',
      stations: '榜单',
      noResults: '没有找到',
      noResultsHint: '换个关键词试试。',
      seeAll: '查看全部',
      recentlyPlayed: '最近播放',
      recentlyAdded: '最近添加',
      kinds: {
        album: '专辑',
        playlist: '歌单',
        artist: '歌手',
        station: '榜单',
        song: '歌曲',
        curator: '分类',
        folder: '文件夹',
      },
      length: (songs, seconds) => {
        const minutes = Math.round(seconds / 60)
        return `${songs} 首，${minutes} 分钟`
      },
      topSongs: '热门歌曲',
      play: '播放',
      shuffle: '随机播放',
      live: '直播',
      preview: '试听',
      upNext: '接下来',
      lyrics: '歌词',
      noLyrics: '这首歌没有歌词。',
      writtenBy: (names) => `作词：${names}`,
      from: (name) => `来自 ${name}`,
      favorite: '收藏',
      favorited: '已收藏',
      unfavorited: '已取消收藏',
      addToLibrary: '加入我的音乐',
      added: '已加入我的音乐',
      signIn: '登录',
      signOut: '退出登录',
      account: '账号',
      filter: '筛选',
      more: '更多',
      all: { playlists: '全部歌单', albums: '全部专辑', songs: '全部歌曲' },
      favorites: '我喜欢的音乐',
      grid: '网格',
      list: '列表',
      find: '筛选',
      sorts: { name: '默认', '-dateAdded': '按添加时间', '-lastPlayed': '按最近播放', '-updated': '按更新时间', type: '类型' },
      finishOnPc: '请在电脑上的网易云登录窗口中完成登录。',
      homePitch: {
        title: '登录网易云音乐',
        text: '登录后可查看每日推荐、我的歌单与收藏。',
      },
      libraryPitch: {
        title: '登录网易云音乐',
        text: '登录后可查看我的歌单、收藏的专辑与歌手。',
      },
      promptTitle: '登录网易云音乐',
      promptFor: { library: '登录后可把歌曲收藏到「我喜欢的音乐」。', favorite: '登录后可收藏歌曲。' },
      notNow: '以后再说',
      // The cab's short note while a VIP song plays as its 30 seconds.
      previewBanner: { title: '试听 30 秒', text: '完整版需要黑胶VIP。' },
      empty: '这里还没有内容。',
      cantPlay: '网易云音乐暂时无法播放这首歌。',
      failed: '网易云音乐没有回应。',
      tryAgain: '重试',
      back: '返回',
      close: '关闭',
      nowPlaying: '正在播放',
      next: '下一首',
      previous: '上一首',
      repeat: '循环',
    },
  }
}
