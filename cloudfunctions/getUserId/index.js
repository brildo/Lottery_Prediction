// Cloud Function: getUserId
// Automatically receives the caller's openid from WeChat servers.
// No auth required — WeChat injects userInfo automatically.
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
    // event.userInfo.openId is automatically provided by WeChat
    const { OPENID } = cloud.getWXContext();
    return {
        openid: OPENID
    };
};
