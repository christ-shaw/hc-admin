/**
 * 应用入口 - 初始化、事件绑定、模块协调
 */

const { PAGE_SIZE } = window.AppConfig;

/**
 * 加载下一页
 */
async function loadNextPage(type) {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;
    
    if (type === 'inbound') {
        const state = StateManager.getInboundState();
        const totalPages = Math.ceil(state.currentRecords.length / PAGE_SIZE);
        const targetPage = state.currentPage + 1;

        // 如果目标页在已加载范围内，直接切换
        if (targetPage <= totalPages) {
            StateManager.setInboundPage(targetPage);
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, state.currentRecords, type, targetPage, state.nextCursor);
            return;
        }

        // 如果需要加载更多数据
        if (state.hasMore) {
            console.log('加载更多入库记录，使用过滤条件:', state.currentFilters);
            const result = await API.fetchInboundRecords(state.nextCursor, state.currentFilters);
            if (result) {
                const container = document.getElementById('inbound-list');
                Render.renderRecords(container, result.records, type, result.currentPage, result.nextCursor);
            }
        }
    } else {
        const state = StateManager.getOutboundState();
        const totalPages = Math.ceil(state.currentRecords.length / PAGE_SIZE);
        const targetPage = state.currentPage + 1;

        // 如果目标页在已加载范围内，直接切换
        if (targetPage <= totalPages) {
            StateManager.setOutboundPage(targetPage);
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, state.currentRecords, type, targetPage, state.nextCursor);
            return;
        }

        // 如果需要加载更多数据
        if (state.hasMore) {
            console.log('加载更多出库记录，使用过滤条件:', state.currentFilters);
            const result = await API.fetchOutboundRecords(state.nextCursor, state.currentFilters);
            if (result) {
                const container = document.getElementById('outbound-list');
                Render.renderRecords(container, result.records, type, result.currentPage, result.nextCursor);
            }
        }
    }
}

/**
 * 切换页面
 */
async function changePage(type, page) {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;

    if (type === 'inbound') {
        const state = StateManager.getInboundState();
        const totalPages = Math.ceil(state.currentRecords.length / PAGE_SIZE);

        // 如果目标页在已加载范围内，直接切换
        if (page <= totalPages) {
            StateManager.setInboundPage(page);
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, state.currentRecords, type, page, state.nextCursor);
            return;
        }

        // 如果目标页未加载，需要加载更多数据
        if (state.hasMore) {
            console.log('跳转到第' + page + '页，需要加载更多数据');
            const pagesToLoad = page - totalPages;
            for (let i = 0; i < pagesToLoad && state.hasMore; i++) {
                await API.fetchInboundRecords(state.nextCursor, state.currentFilters);
            }
            const newState = StateManager.getInboundState();
            const targetPage = Math.min(page, Math.ceil(newState.currentRecords.length / PAGE_SIZE));
            StateManager.setInboundPage(targetPage);
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, newState.currentRecords, type, targetPage, newState.nextCursor);
        }
    } else {
        const state = StateManager.getOutboundState();
        const totalPages = Math.ceil(state.currentRecords.length / PAGE_SIZE);

        // 如果目标页在已加载范围内，直接切换
        if (page <= totalPages) {
            StateManager.setOutboundPage(page);
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, state.currentRecords, type, page, state.nextCursor);
            return;
        }

        // 如果目标页未加载，需要加载更多数据
        if (state.hasMore) {
            console.log('跳转到第' + page + '页，需要加载更多数据');
            const pagesToLoad = page - totalPages;
            for (let i = 0; i < pagesToLoad && state.hasMore; i++) {
                await API.fetchOutboundRecords(state.nextCursor, state.currentFilters);
            }
            const newState = StateManager.getOutboundState();
            const targetPage = Math.min(page, Math.ceil(newState.currentRecords.length / PAGE_SIZE));
            StateManager.setOutboundPage(targetPage);
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, newState.currentRecords, type, targetPage, newState.nextCursor);
        }
    }
}

/**
 * 应用过滤条件
 */
async function applyFilters() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;
    
    // 检查当前激活的标签页
    const isInboundTab = document.getElementById('tab-inbound').classList.contains('active');

    if (isInboundTab) {
        // 获取入库页面的过滤条件
        const customerName = document.getElementById('filter-name').value.trim();
        const channelType = document.getElementById('filter-type').value.trim();
        const shopName = document.getElementById('filter-shopname').value.trim();
        const trackingNumber = document.getElementById('filter-tracking').value.trim();
        const phoneModel = document.getElementById('filter-phone-model').value.trim();
        const hasIssue = document.getElementById('filter-has-issue').value;
        const startDate = document.getElementById('filter-date-inbound-start').value;
        const endDate = document.getElementById('filter-date-inbound-end').value;

        console.log('========== 调试：获取过滤条件 ==========');
        console.log('客户名称:', customerName);
        console.log('渠道类型:', channelType);
        console.log('渠道名称:', shopName);
        console.log('快递单号:', trackingNumber);
        console.log('手机型号:', phoneModel);
        console.log('异常状态:', hasIssue);
        console.log('开始日期:', startDate);
        console.log('结束日期:', endDate);
        console.log('====================================');

        // 构建过滤条件对象
        const filters = {};
        if (customerName) filters.customerName = customerName;
        if (channelType) filters.channelType = channelType;
        if (shopName) filters.shopName = shopName;
        if (trackingNumber) filters.trackingNumber = trackingNumber;
        if (phoneModel) filters.model = phoneModel;
        if (hasIssue !== '') filters.hasIssue = hasIssue === 'true'; // 转换为布尔值
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        console.log('应用入库过滤条件:', filters);

        // 重新查询入库记录
        StateManager.resetInbound();
        const result = await API.fetchInboundRecords(null, filters);
        if (result) {
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, result.records, 'inbound', result.currentPage, result.nextCursor);
        }
    } else {
        // 获取出库页面的过滤条件
        const customerName = document.getElementById('filter-name-outbound').value.trim();
        const phoneModel = document.getElementById('filter-phone-model-outbound').value.trim();
        const startDate = document.getElementById('filter-date-outbound-start').value;
        const endDate = document.getElementById('filter-date-outbound-end').value;

        // 构建过滤条件对象
        const filters = {};
        if (customerName) filters.customerName = customerName;
        if (phoneModel) filters.model = phoneModel;
        if (startDate) filters.startDate = startDate;
        if (endDate) filters.endDate = endDate;

        console.log('应用出库过滤条件:', filters);

        // 重新查询出库记录
        StateManager.resetOutbound();
        const result = await API.fetchOutboundRecords(null, filters);
        if (result) {
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, result.records, 'outbound', result.currentPage, result.nextCursor);
        }
    }
}

/**
 * 重置过滤条件
 */
async function resetFilters() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;
    
    // 检查当前激活的标签页
    const isInboundTab = document.getElementById('tab-inbound').classList.contains('active');

    if (isInboundTab) {
        // 清空入库页面的输入框
        document.getElementById('filter-name').value = '';
        document.getElementById('filter-type').value = '';
        document.getElementById('filter-shopname').value = '';
        document.getElementById('filter-date-inbound-start').value = '';
        document.getElementById('filter-date-inbound-end').value = '';
        document.getElementById('filter-tracking').value = '';
        document.getElementById('filter-phone-model').value = '';
        document.getElementById('filter-has-issue').value = '';

        // 重新查询入库记录（不带任何过滤条件）
        StateManager.resetInbound();
        const result = await API.fetchInboundRecords(null, {});
        if (result) {
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, result.records, 'inbound', result.currentPage, result.nextCursor);
        }

        console.log('已重置入库过滤条件，重新加载数据');
    } else {
        // 清空出库页面的输入框
        document.getElementById('filter-name-outbound').value = '';
        document.getElementById('filter-phone-model-outbound').value = '';
        document.getElementById('filter-date-outbound-start').value = '';
        document.getElementById('filter-date-outbound-end').value = '';

        // 重新查询出库记录（不带任何过滤条件）
        StateManager.resetOutbound();
        const result = await API.fetchOutboundRecords(null, {});
        if (result) {
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, result.records, 'outbound', result.currentPage, result.nextCursor);
        }

        console.log('已重置出库过滤条件，重新加载数据');
    }
}

/**
 * 根据类型加载渠道（用于过滤区域）
 */
async function loadShopsByTypeForFilter(type) {
    const API = window.API;
    const filterShopSelect = document.getElementById('filter-shopname');
    if (!filterShopSelect) return;

    try {
        // 如果没有选择类型（全部），渠道名称也只显示全部
        if (!type) {
            filterShopSelect.innerHTML = '<option value="">全部</option>';
            return;
        }

        const shops = await API.loadShopsByType(type);
        console.log(`按类型${type}获取的渠道列表（过滤区域）:`, shops);

        let shopOptions = shops.map(shop =>
            `<option value="${shop.name}">${shop.name}</option>`
        ).join('');

        filterShopSelect.innerHTML = shopOptions;
    } catch (error) {
        console.error('加载渠道列表失败:', error);
        alert('加载渠道列表失败：' + error.message);
    }
}

/**
 * 确认删除记录
 */
async function confirmDelete() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;
    
    const record = StateManager.getCurrentEditingRecord();
    const type = StateManager.getCurrentEditingType();
    
    if (!record) {
        alert('没有可删除的记录');
        return;
    }

    const recordId = record._id;
    const isInbound = type === 'inbound';
    const typeText = isInbound ? '入库' : '出库';

    // 弹出确认框
    const confirmed = confirm(`确定要删除这条${typeText}记录吗？\n\n记录ID: ${recordId}\n\n此操作不可撤销！`);

    if (!confirmed) {
        return;
    }

    try {
        const success = await API.deleteRecord(recordId, type);
        if (success) {
            alert('删除成功！');
            Render.closeModal();

            // 刷新记录列表
            if (isInbound) {
                StateManager.resetInbound();
                const result = await API.fetchInboundRecords(null, StateManager.getInboundState().currentFilters);
                if (result) {
                    const container = document.getElementById('inbound-list');
                    Render.renderRecords(container, result.records, 'inbound', result.currentPage, result.nextCursor);
                }
            } else {
                StateManager.resetOutbound();
                const result = await API.fetchOutboundRecords(null, StateManager.getOutboundState().currentFilters);
                if (result) {
                    const container = document.getElementById('outbound-list');
                    Render.renderRecords(container, result.records, 'outbound', result.currentPage, result.nextCursor);
                }
            }
        } else {
            alert('删除失败');
        }
    } catch (error) {
        console.error('删除记录失败:', error);
        alert('删除失败：' + error.message);
    }
}

/**
 * 保存记录
 */
async function saveRecord() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;
    
    const record = StateManager.getCurrentEditingRecord();
    const type = StateManager.getCurrentEditingType();
    
    if (!record) {
        alert('没有可保存的记录');
        return;
    }

    console.log('========== 保存记录调试 ==========');
    console.log('currentEditingRecord 完整对象:', JSON.stringify(record, null, 2));
    console.log('currentEditingRecord 所有字段:', Object.keys(record));
    console.log('currentEditingRecord._id:', record._id);
    console.log('==============================');

    const isInbound = type === 'inbound';

    // 获取表单数据
    const customerName = document.getElementById('edit-customerName').value.trim();
    let date;
    let updateData = {
        customerName: customerName
    };

    if (isInbound) {
        date = document.getElementById('edit-inboundDate').value;
        const channelType = document.getElementById('edit-type').value;
        const shopCode = document.getElementById('edit-shopName').value.trim();
        const trackingNumber = document.getElementById('edit-trackingNumber').value.trim();

        if (!date) {
            alert('请选择入库日期');
            return;
        }
        if (!customerName) {
            alert('请输入客户名称');
            return;
        }

        updateData.inboundDate = date;
        updateData.type = channelType;
        updateData.shopName = shopCode;
        updateData.trackingNumber = trackingNumber;
    } else {
        date = document.getElementById('edit-outboundDate').value;

        if (!date) {
            alert('请选择出库日期');
            return;
        }
        if (!customerName) {
            alert('请输入客户名称');
            return;
        }

        updateData.outboundDate = date;
    }

    // 获取手机型号
    const phoneModelSelects = document.querySelectorAll('.phone-model-select');
    const phoneModels = [];
    phoneModelSelects.forEach(select => {
        const model = select.value;
        const quantityInput = select.parentElement.querySelector('.phone-quantity');
        const quantity = parseInt(quantityInput.value) || 1;

        if (model) {
            phoneModels.push({ model, quantity });
        }
    });

    if (phoneModels.length === 0) {
        alert('请至少添加一个手机型号');
        return;
    }

    updateData.phoneModels = phoneModels;

    // 从数据库记录中获取_id
    const recordId = record._id;

    if (!recordId) {
        console.error('记录ID不存在，record:', record);
        alert('记录ID不能为空，请重新选择记录');
        return;
    }

    try {
        const success = await API.updateRecord(recordId, type, updateData);
        if (success) {
            // 保存操作日志
            const logResult = await API.saveOperationLog('update', type, recordId, customerName, '网页用户');
            console.log('保存日志结果:', logResult);
            console.log('日志ID:', logResult.logId);
            
            // 发送企业微信通知,包含操作日志ID
            const recordData = { ...record, ...updateData };
            const operationLogId = logResult.success ? logResult.logId : null;
            console.log('准备发送通知, operationLogId:', operationLogId);
            await API.notifyRecordChange('update', type, recordData, operationLogId);

            alert('保存成功！');
            Render.closeEditModal();

            // 刷新记录列表
            if (isInbound) {
                const result = await API.fetchInboundRecords(null, StateManager.getInboundState().currentFilters);
                if (result) {
                    const container = document.getElementById('inbound-list');
                    Render.renderRecords(container, result.records, 'inbound', result.currentPage, result.nextCursor);
                }
            } else {
                const result = await API.fetchOutboundRecords(null, StateManager.getOutboundState().currentFilters);
                if (result) {
                    const container = document.getElementById('outbound-list');
                    Render.renderRecords(container, result.records, 'outbound', result.currentPage, result.nextCursor);
                }
            }
        } else {
            alert('保存失败');
        }
    } catch (error) {
        console.error('保存记录失败:', error);
        alert('保存失败：' + error.message);
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', async () => {
    const API = window.API;
    const Render = window.Render;
    
    // 点击弹窗外部关闭
    document.getElementById('detail-modal').addEventListener('click', function(e) {
        if (e.target === this) {
            Render.closeModal();
        }
    });

    // 点击页面其他地方关闭下拉菜单
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('settings-dropdown');
        const settingsBtn = document.querySelector('.settings-btn');
        
        if (dropdown && !dropdown.contains(e.target) && e.target !== settingsBtn) {
            dropdown.classList.remove('active');
        }
    });

    // 点击手机型号弹窗外部关闭
    document.getElementById('phone-models-modal').addEventListener('click', function(e) {
        if (e.target === this) {
            closePhoneModelsModal();
        }
    });

    // 初始化云开发并加载数据
    const initialized = await API.initCloudBase();
    if (initialized) {
        // 并行加载入库和出库记录
        const [inboundResult, outboundResult] = await Promise.all([
            API.fetchInboundRecords(),
            API.fetchOutboundRecords()
        ]);

        // 渲染入库记录
        if (inboundResult) {
            const container = document.getElementById('inbound-list');
            Render.renderRecords(container, inboundResult.records, 'inbound', inboundResult.currentPage, inboundResult.nextCursor);
        }

        // 渲染出库记录
        if (outboundResult) {
            const container = document.getElementById('outbound-list');
            Render.renderRecords(container, outboundResult.records, 'outbound', outboundResult.currentPage, outboundResult.nextCursor);
        }

        // 添加渠道类型联动事件监听（过滤区域）
        const filterTypeSelect = document.getElementById('filter-type');
        if (filterTypeSelect) {
            filterTypeSelect.addEventListener('change', async function() {
                const selectedType = this.value;
                await loadShopsByTypeForFilter(selectedType);
            });
        }
    }
});

// 统计数据加载标记
// 导出到全局
window.applyFilters = applyFilters;
window.resetFilters = resetFilters;
window.confirmDelete = confirmDelete;
window.saveRecord = saveRecord;

// 日志加载标记
let logsLoaded = false;

/**
 * 加载操作日志
 */
async function loadLogsData() {
    // 避免重复加载
    if (logsLoaded) return;

    const API = window.API;
    const Render = window.Render;
    const StateManager = window.StateManager;

    try {
        // 首次查询不传游标
        const result = await API.fetchOperationLogs(null);
        if (result) {
            const container = document.getElementById('logs-list');
            Render.renderLogs(container, result.records, 1, result.cursor, result.hasMore, result.total);
            logsLoaded = true;
        }
    } catch (error) {
        console.error('加载操作日志失败:', error);
    }
}

/**
 * 应用日志筛选条件
 */
async function applyLogsFilters() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;

    // 获取筛选条件
    const operator = document.getElementById('filter-logs-operator').value.trim();
    const operationType = document.getElementById('filter-logs-operation-type').value;
    const logType = document.getElementById('filter-logs-log-type').value;
    const startDate = document.getElementById('filter-logs-start-date').value;
    const endDate = document.getElementById('filter-logs-end-date').value;

    console.log('应用日志筛选条件:', { operator, operationType, logType, startDate, endDate });

    // 构建过滤条件
    const filters = {};
    if (operator) filters.operator = operator;
    if (operationType) filters.operationType = operationType;
    if (logType) filters.logType = logType;
    if (startDate) filters.startDate = startDate;
    if (endDate) filters.endDate = endDate;

    // 重置并重新查询（不传游标）
    StateManager.resetLogs();
    StateManager.setLogsState({ currentFilters: filters });

    const result = await API.fetchOperationLogs(null, filters);
    if (result) {
        const container = document.getElementById('logs-list');
        Render.renderLogs(container, result.records, 1, result.cursor, result.hasMore, result.total);
    }
}

/**
 * 重置日志筛选条件
 */
async function resetLogsFilters() {
    const StateManager = window.StateManager;
    const Render = window.Render;
    const API = window.API;

    // 清空表单
    document.getElementById('filter-logs-operator').value = '';
    document.getElementById('filter-logs-operation-type').value = '';
    document.getElementById('filter-logs-log-type').value = '';
    document.getElementById('filter-logs-start-date').value = '';
    document.getElementById('filter-logs-end-date').value = '';

    // 重置并重新查询（不传游标）
    StateManager.resetLogs();

    const result = await API.fetchOperationLogs(null);
    if (result) {
        const container = document.getElementById('logs-list');
        Render.renderLogs(container, result.records, 1, result.cursor, result.hasMore, result.total);
    }
}

// 导出日志相关函数
window.loadLogsData = loadLogsData;
window.applyLogsFilters = applyLogsFilters;
window.resetLogsFilters = resetLogsFilters;

/**
 * 切换设置菜单显示/隐藏
 */
function toggleSettingsMenu(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('settings-dropdown');
    dropdown.classList.toggle('active');
}

/**
 * 打开手机型号弹窗
 */
async function openPhoneModelsModal() {
    const API = window.API;
    
    // 关闭下拉菜单
    document.getElementById('settings-dropdown').classList.remove('active');
    
    // 显示弹窗
    const modal = document.getElementById('phone-models-modal');
    const content = document.getElementById('phone-models-content');
    modal.classList.add('active');
    
    // 隐藏表单
    hideAddBrandForm();
    hideAddModelForm();
    
    // 显示加载状态
    content.innerHTML = '<div class="loading">加载中...</div>';
    
    try {
        // 调用 API 获取品牌列表（带型号）
        const brands = await API.loadPhoneBrands();
        
        if (brands && brands.length > 0) {
            // 检查数据格式
            if (typeof brands[0] === 'string') {
                // 如果返回的是字符串数组（品牌名），需要逐个获取型号
                const html = await Promise.all(brands.map(async (brandName, index) => {
                    try {
                        const models = await API.loadPhoneModels(brandName);
                        return `
                            <div class="brand-item">
                                <div class="brand-header" onclick="toggleBrand(${index})">
                                    <span class="brand-name">${brandName}</span>
                                    <span class="brand-arrow">▼</span>
                                </div>
                                <div class="brand-models" id="brand-models-${index}">
                                    ${models && models.length > 0 ? models.map(model => `
                                        <div class="phone-model-list-item">
                                            <span class="phone-model-name">${model}</span>
                                        </div>
                                    `).join('') : '<div class="phone-model-list-item"><span class="phone-model-name">暂无型号</span></div>'}
                                </div>
                            </div>
                        `;
                    } catch (error) {
                        console.error(`获取品牌 ${brandName} 的型号失败:`, error);
                        return '';
                    }
                }));
                content.innerHTML = html.join('');
            } else if (brands[0].brand && brands[0].models) {
                // 如果返回的是对象数组 {brand: string, models: string[]}
                console.log('返回的是品牌对象数组');
                const html = brands.map((brand, index) => `
                    <div class="brand-item">
                        <div class="brand-header" onclick="toggleBrand(${index})">
                            <span class="brand-name">${brand.brand}</span>
                            <span class="brand-arrow">▼</span>
                        </div>
                        <div class="brand-models" id="brand-models-${index}">
                            ${brand.models && brand.models.length > 0 ? brand.models.map(model => `
                                <div class="phone-model-list-item">
                                    <span class="phone-model-name">${model}</span>
                                </div>
                            `).join('') : '<div class="phone-model-list-item"><span class="phone-model-name">暂无型号</span></div>'}
                        </div>
                    </div>
                `).join('');
                content.innerHTML = html;
            } else {
                console.error('未知的数据格式:', brands[0]);
                content.innerHTML = '<div class="error">数据格式错误</div>';
            }
        } else {
            content.innerHTML = '<div class="empty">暂无手机型号数据</div>';
        }
    } catch (error) {
        console.error('加载手机型号失败:', error);
        content.innerHTML = `<div class="error">加载失败: ${error.message}</div>`;
    }
}

/**
 * 显示添加品牌表单
 */
function showAddBrandForm() {
    document.getElementById('add-brand-form').style.display = 'block';
    document.getElementById('add-model-form').style.display = 'none';
    document.getElementById('new-brand-name').value = '';
}

/**
 * 隐藏添加品牌表单
 */
function hideAddBrandForm() {
    document.getElementById('add-brand-form').style.display = 'none';
    document.getElementById('new-brand-name').value = '';
}

/**
 * 显示添加型号表单
 */
async function showAddModelForm() {
    const API = window.API;
    
    document.getElementById('add-model-form').style.display = 'block';
    document.getElementById('add-brand-form').style.display = 'none';
    document.getElementById('new-models-input').value = '';
    
    // 加载品牌列表到下拉框
    try {
        const brands = await API.loadPhoneBrands();
        const select = document.getElementById('model-brand-select');
        
        let options = '<option value="">请选择品牌</option>';
        if (brands && brands.length > 0) {
            if (typeof brands[0] === 'string') {
                // 字符串数组
                brands.forEach(brand => {
                    options += `<option value="${brand}">${brand}</option>`;
                });
            } else if (brands[0].brand) {
                // 对象数组
                brands.forEach(item => {
                    options += `<option value="${item.brand}">${item.brand}</option>`;
                });
            }
        }
        
        select.innerHTML = options;
    } catch (error) {
        console.error('加载品牌列表失败:', error);
    }
}

/**
 * 隐藏添加型号表单
 */
function hideAddModelForm() {
    document.getElementById('add-model-form').style.display = 'none';
    document.getElementById('new-models-input').value = '';
    document.getElementById('model-brand-select').value = '';
}

/**
 * 提交添加品牌
 */
async function submitAddBrand() {
    const API = window.API;
    const brandName = document.getElementById('new-brand-name').value.trim();
    
    if (!brandName) {
        alert('请输入品牌名称');
        return;
    }
    
    try {
        const result = await API.addPhoneBrand(brandName);
        
        if (result.success) {
            alert('添加品牌成功！');
            hideAddBrandForm();
            // 重新加载列表
            await openPhoneModelsModal();
        } else {
            alert(result.errMsg || '添加失败');
        }
    } catch (error) {
        console.error('添加品牌失败:', error);
        alert('添加失败：' + error.message);
    }
}

/**
 * 提交添加型号
 */
async function submitAddModels() {
    const API = window.API;
    const brand = document.getElementById('model-brand-select').value;
    const modelsInput = document.getElementById('new-models-input').value.trim();
    
    if (!brand) {
        alert('请选择品牌');
        return;
    }
    
    if (!modelsInput) {
        alert('请输入手机型号');
        return;
    }
    
    // 解析型号（用逗号分隔）
    const models = modelsInput.split(/[,，]/).map(m => m.trim()).filter(m => m);
    
    if (models.length === 0) {
        alert('请输入至少一个手机型号');
        return;
    }
    
    try {
        const result = await API.addPhoneModels(brand, models);
        
        if (result.success) {
            alert(`成功添加 ${result.addedCount} 个型号！`);
            hideAddModelForm();
            // 重新加载列表
            await openPhoneModelsModal();
        } else {
            alert(result.errMsg || '添加失败');
        }
    } catch (error) {
        console.error('添加型号失败:', error);
        alert('添加失败：' + error.message);
    }
}

/**
 * 展开/收起品牌
 */
function toggleBrand(index) {
    const header = document.querySelector(`.brand-item:nth-child(${index + 1}) .brand-header`);
    const models = document.getElementById(`brand-models-${index}`);
    
    if (header && models) {
        header.classList.toggle('expanded');
        models.classList.toggle('expanded');
    }
}

/**
 * 关闭手机型号弹窗
 */
function closePhoneModelsModal() {
    const modal = document.getElementById('phone-models-modal');
    modal.classList.remove('active');
}

// 导出函数到全局
window.toggleSettingsMenu = toggleSettingsMenu;
window.openPhoneModelsModal = openPhoneModelsModal;
window.closePhoneModelsModal = closePhoneModelsModal;
window.toggleBrand = toggleBrand;
window.showAddBrandForm = showAddBrandForm;
window.hideAddBrandForm = hideAddBrandForm;
window.showAddModelForm = showAddModelForm;
window.hideAddModelForm = hideAddModelForm;
window.submitAddBrand = submitAddBrand;
window.submitAddModels = submitAddModels;
