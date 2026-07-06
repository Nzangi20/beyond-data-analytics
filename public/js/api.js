// ==================== BDA API CLIENT ====================
const API = {
    baseUrl: '/api',
    token: localStorage.getItem('bda_token'),

    setToken(token) {
        this.token = token;
        localStorage.setItem('bda_token', token);
    },

    clearToken() {
        this.token = null;
        localStorage.removeItem('bda_token');
        localStorage.removeItem('bda_user');
    },

    getUser() {
        const data = localStorage.getItem('bda_user');
        return data ? JSON.parse(data) : null;
    },

    setUser(user) {
        localStorage.setItem('bda_user', JSON.stringify(user));
    },

    async request(method, endpoint, data = null, isFormData = false) {
        const headers = {};
        if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
        if (!isFormData) headers['Content-Type'] = 'application/json';

        const config = { method, headers };
        if (data) {
            config.body = isFormData ? data : JSON.stringify(data);
        }

        try {
            const response = await fetch(`${this.baseUrl}${endpoint}`, config);
            const result = await response.json();

            if (response.status === 401) {
                if (result.error === 'Token expired' || result.error === 'Access token required') {
                    this.clearToken();
                    window.location.href = '/login';
                    return;
                }
            }

            if (response.status === 403 && result.requirePasswordChange) {
                window.location.href = '/change-password';
                return;
            }

            if (!response.ok) {
                throw { status: response.status, ...result };
            }

            return result;
        } catch (err) {
            if (err.status) throw err;
            throw { error: 'Network error. Please check your connection.' };
        }
    },

    get(endpoint) { return this.request('GET', endpoint); },
    post(endpoint, data) { return this.request('POST', endpoint, data); },
    put(endpoint, data) { return this.request('PUT', endpoint, data); },
    delete(endpoint) { return this.request('DELETE', endpoint); },
    upload(endpoint, formData) { return this.request('POST', endpoint, formData, true); },

    // Auth check
    isLoggedIn() { return !!this.token; },

    requireAuth(allowedRoles = []) {
        if (!this.isLoggedIn()) {
            window.location.href = '/login';
            return false;
        }
        const user = this.getUser();
        if (user && user.firstLogin) {
            window.location.href = '/change-password';
            return false;
        }
        if (allowedRoles.length > 0 && user && !allowedRoles.includes(user.role)) {
            window.location.href = '/login';
            return false;
        }
        return true;
    },

    logout() {
        this.post('/auth/logout').catch(() => {});
        this.clearToken();
        window.location.href = '/login';
    }
};

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'success', duration = 4000) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fas ${icons[type] || icons.success}" style="color: var(--${type === 'error' ? 'red' : type === 'warning' ? 'golden' : 'green'})"></i><span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ==================== SIDEBAR TOGGLE ====================
function toggleSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('open');
}

// Close sidebar on outside click (mobile)
document.addEventListener('click', (e) => {
    const sidebar = document.querySelector('.sidebar');
    const toggle = document.querySelector('.sidebar-toggle');
    if (sidebar?.classList.contains('open') && !sidebar.contains(e.target) && !toggle?.contains(e.target)) {
        sidebar.classList.remove('open');
    }
});

// ==================== UTILITY FUNCTIONS ====================
function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
    });
}

function formatDateTime(dateStr) {
    if (!dateStr) return 'N/A';
    return new Date(dateStr).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function getInitials(name) {
    return name ? name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) : '??';
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
