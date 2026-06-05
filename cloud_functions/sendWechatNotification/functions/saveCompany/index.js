/**
 * saveCompany - 新增公司模版
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const payload = event.data || event;
  const { company } = payload;

  if (!company || !company.companyName) {
    return { success: false, errMsg: '缺少单位名称' };
  }

  try {
    // 检查是否已存在同名公司
    const existResult = await db.collection('companies')
      .where({ companyName: company.companyName })
      .limit(1).get();

    if (existResult.data && existResult.data.length > 0) {
      return { success: false, errMsg: '该公司已存在' };
    }

    const record = {
      ...company,
      createTime: db.serverDate(),
    };

    const result = await db.collection('companies').add({ data: record });
    return { success: true, _id: result._id };
  } catch (error) {
    console.error('新增公司模版失败:', error);
    return { success: false, errMsg: error.message || '新增失败' };
  }
};
