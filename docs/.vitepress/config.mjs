import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "王左的软件架构实验博客",
  description: "记录软件架构课程实验的设计与实现过程",
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '实验记录', link: '/labs/lab1' }
    ],

    sidebar: [
      {
        text: '实验记录',
        items: [
          { text: '实验一：环境搭建', link: '/labs/lab1' },
          { text: '实验二：ADT 与 Provider', link: '/labs/lab2' },
          { text: '实验三：重构与设计模式', link: '/labs/lab3' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/WangZuo' }
    ],

    footer: {
      message: '软件架构课程实验记录',
      copyright: 'Copyright © 2026 王左'
    }
  }
})
