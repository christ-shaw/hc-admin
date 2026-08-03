/**
 * sendWechatNotification - 企业微信群机器人消息推送云函数
 *
 * 用于解决前端直接调用企业微信API的CORS问题
 *
 * 请求参数:
 * {
 *   webhookUrl: string,  // 企业微信机器人Webhook地址
 *   msgtype: string,    // 消息类型: 'text' 或 'markdown'
 *   content: string      // 消息内容
 * }
 *
 * 返回结果:
 * {
 *   success: boolean,
 *   errMsg: string
 * }
 */

const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

exports.main = async (event, context) => {
  const { webhookUrl, msgtype, content } = event;

  // 参数验证
  if (!webhookUrl) {
    return {
      success: false,
      errMsg: '缺少webhookUrl参数'
    };
  }

  if (!msgtype || !content) {
    return {
      success: false,
      errMsg: '缺少必要参数'
    };
  }

  try {
    // 构建请求参数
    let messageData;
    if (msgtype === 'markdown') {
      messageData = {
        msgtype: 'markdown',
        markdown: {
          content: content
        }
      };
    } else {
      messageData = {
        msgtype: 'text',
        text: {
          content: content
        }
      };
    }

    // 调用企业微信API
    const response = await axios.post(webhookUrl, messageData, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = response.data;

    if (result.errcode === 0) {
      return {
        success: true
      };
    } else {
      return {
        success: false,
        errMsg: `企业微信API返回错误: ${result.errmsg}`
      };
    }
  } catch (error) {
    console.error('企业微信推送失败:', error);
    return {
      success: false,
      errMsg: error.message || '推送失败'
    };
  }
};
