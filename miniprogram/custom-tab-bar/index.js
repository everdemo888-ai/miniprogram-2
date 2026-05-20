Component({
  data: {
    selected: 0,
    safeBottom: 0,
  },
  lifetimes: {
    attached() {
      const sys = wx.getSystemInfoSync();
      const safe =
        sys.safeAreaInsets && sys.safeAreaInsets.bottom
          ? sys.safeAreaInsets.bottom
          : 0;
      this.setData({ safeBottom: safe });
    },
  },
  methods: {
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      const index = Number(e.currentTarget.dataset.index);
      wx.switchTab({ url: path });
      this.setData({ selected: index });
    },
  },
});
