/**
 * getCloudFileUrls - 批量获取云存储文件临时访问链接
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const payload = event.data || event || {};
  const fileIDs = Array.isArray(payload.fileIDs) ? payload.fileIDs.filter(Boolean) : [];

  if (fileIDs.length === 0) {
    return { success: true, fileList: [] };
  }

  try {
    const result = await cloud.getTempFileURL({
      fileList: fileIDs,
    });

    return {
      success: true,
      fileList: (result.fileList || []).map((item) => ({
        fileID: item.fileID,
        tempFileURL: item.tempFileURL || '',
        status: item.status,
        maxAge: item.maxAge,
      })),
    };
  } catch (error) {
    console.error('获取云存储临时链接失败:', error);
    return {
      success: false,
      errMsg: error.message || '获取云存储临时链接失败',
      fileList: [],
    };
  }
};
