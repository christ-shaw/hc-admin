/**
 * sendWechatNotification - 企业微信群机器人消息推送云函数
 * 
 * 使用 cloud.curl 发送HTTP请求
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async (event, context) => {
  const { webhookUrl, msgtype, content } = event;

  // 参数验证
  if (!webhookUrl) {
    return { success: false, errMsg: '缺少webhookUrl参数' };
  }

  if (!msgtype || !content) {
    return { success: false, errMsg: '缺少必要参数' };
  }

  try {
    // 构建请求参数
    let messageData;
    if (msgtype === 'markdown') {
      messageData = {
        msgtype: 'markdown',
        markdown: { content }
      };
    } else {
      messageData = {
        msgtype: 'text',
        text: { content }
      };
    }

    // 使用 cloud.curl 发送请求
    const response = await cloud.curl({
      url: webhookUrl,
      method: 'POST',
      header: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messageData)
    });

    const result = JSON.parse(response.res.data);

    if (result.errcode === 0) {
      return { success: true };
    } else {
      return { success: false, errMsg: `企业微信API返回错误: ${result.errmsg}` };
    }
  } catch (error) {
    console.error('企业微信推送失败:', error);
    return { success: false, errMsg: error.message || '推送失败' };
  }
};
