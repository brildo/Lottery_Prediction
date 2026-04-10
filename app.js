const env = require('./env.js');

App({
    onLaunch() {
        console.log('App Launch');
        // wx.cloud initialization has been completely removed
    },
    globalData: {
        userInfo: null
    }
})
