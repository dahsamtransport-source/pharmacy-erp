# Module Architecture

## Module Dependency Graph

```
┌─────────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                       │
│  (React Components, Pages, UI State Management)              │
└──────┬──────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────��───────────┐
│                    SERVICE LAYER                            │
│  (Business Logic, Orchestration, Validation)                │
└──────┬──────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│                   DOMAIN MODULES                            │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│ Core:                                                        │
│  • auth/       (Authentication & Session)                   │
│  • users/      (User Management)                            │
│  • orgs/       (Organization Management)                    │
│                                                              │
│ Pharmacy Operations:                                        │
│  • pharmacy/   (Pharmacy Config, License)                   │
│  • products/   (Drug & Item Catalog)                        │
│  • inventory/  (Stock Management)                           │
│  • suppliers/  (Supplier Management)                        │
│                                                              │
│ Customer & Prescription:                                    │
│  • customers/  (Patient Profiles)                           │
│  • prescriptions/  (Rx Management)                          │
│                                                              │
│ Commerce:                                                   │
│  • orders/     (Purchase Orders)                            │
│  • billing/    (Invoicing & Payments)                       │
│                                                              │
│ Analytics & Intelligence:                                   │
│  • reports/    (Report Generation)                          │
│  • analytics/  (Data Analysis)                              │
│  • ai/         (AI Agent Platform)                          │
│  • notifications/  (Alerts & Messages)                      │
│  • marketing/  (Campaign Management)                        │
│                                                              │
│ Administration:                                             │
│  • admin/      (System Settings & Controls)                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│                 INFRASTRUCTURE LAYER                        │
│  (Database, Cache, Events, Logging)                         │
└─────────────────────────────────────────────────────────────┘
```

## Module Boundaries

### auth/ (Authentication Module)
**Purpose**: Handle user authentication and session management

**Exports**:
- `login(email, password)` → User + Token
- `logout()` → void
- `refreshToken(token)` → NewToken
- `validateToken(token)` → User | null

**Private**:
- Password hashing algorithms
- Session storage internals
- Token generation logic

**Dependencies**: None (lowest level)

**Dependents**: users/, orgs/, all other modules (auth guard)

---

### users/ (User Management Module)
**Purpose**: Manage user profiles, roles, permissions

**Exports**:
- `getUserById(id)` → User
- `updateUserProfile(id, data)` → User
- `assignRole(userId, role)` → void
- `hasPermission(userId, permission)` → boolean

**Private**:
- Permission calculation logic
- User cache management

**Dependencies**: auth/

**Dependents**: orgs/, admin/

---

### pharmacy/ (Pharmacy Operations Module)
**Purpose**: Manage pharmacy configuration, licenses, regulations

**Exports**:
- `getPharmacyConfig()` → Config
- `updatePharmacyInfo(data)` → Pharmacy
- `validateDEANumber(number)` → boolean
- `checkLicenseExpiry()` → ExpiryStatus

**Private**:
- License validation algorithms
- Regulatory compliance checks

**Dependencies**: auth/, orgs/

**Dependents**: products/, orders/, prescriptions/

---

### products/ (Product Catalog Module)
**Purpose**: Manage drug and item catalog

**Exports**:
- `getProductById(id)` → Product
- `searchProducts(query)` → Product[]
- `addProduct(data)` → Product
- `updateProduct(id, data)` → Product
- `checkDrugInteractions(drugs[])` → Interaction[]

**Private**:
- Drug database queries
- Interaction engine

**Dependencies**: pharmacy/, suppliers/

**Dependents**: inventory/, orders/, prescriptions/

---

### inventory/ (Stock Management Module)
**Purpose**: Track and manage inventory levels

**Exports**:
- `getStock(productId)` → StockLevel
- `updateStock(productId, quantity)` → void
- `getReorderSuggestions()` → Suggestion[]
- `trackExpiry(productId)` → void

**Private**:
- Stock level algorithms
- Expiry calculation

**Dependencies**: products/, pharmacy/

**Dependents**: orders/, suppliers/

---

### customers/ (Customer Management Module)
**Purpose**: Manage patient/customer profiles

**Exports**:
- `getCustomerById(id)` → Customer
- `createCustomer(data)` → Customer
- `updateCustomerProfile(id, data)` → Customer
- `getCustomerHistory(id)` → Transaction[]

**Private**:
- Privacy compliance (HIPAA)
- Data anonymization

**Dependencies**: auth/, users/

**Dependents**: prescriptions/, orders/, analytics/

---

### prescriptions/ (Prescription Management Module)
**Purpose**: Manage prescriptions and dispensing

**Exports**:
- `getPrescription(id)` → Prescription
- `validatePrescription(data)` → ValidationResult
- `dispensePrescription(id)` → DispenseResult
- `checkRefills(id)` → RefillCount

**Private**:
- Drug interaction verification
- Dosage validation

**Dependencies**: customers/, products/, pharmacy/

**Dependents**: orders/, billing/

---

### orders/ (Order Management Module)
**Purpose**: Manage purchase and fulfillment orders

**Exports**:
- `createOrder(data)` → Order
- `getOrderStatus(id)` → OrderStatus
- `updateOrderStatus(id, status)` → Order
- `generateShippingLabel(orderId)` → Label

**Private**:
- Order workflow state machine
- Fulfillment logic

**Dependencies**: products/, inventory/, billing/

**Dependents**: notifications/, analytics/

---

### billing/ (Billing & Payments Module)
**Purpose**: Handle invoicing and payment processing

**Exports**:
- `createInvoice(orderId)` → Invoice
- `processPayment(invoiceId, amount)` → Transaction
- `getPaymentStatus(invoiceId)` → PaymentStatus
- `generateReceipt(invoiceId)` → PDF

**Private**:
- Payment gateway integration
- Tax calculation

**Dependencies**: orders/, prescriptions/

**Dependents**: analytics/, notifications/

---

### reports/ (Report Generation Module)
**Purpose**: Generate business and compliance reports

**Exports**:
- `generateSalesReport(startDate, endDate)` → Report
- `generateInventoryReport()` → Report
- `generateComplianceReport()` → Report
- `exportToCSV(report)` → CSV

**Private**:
- Report templates
- Data aggregation

**Dependencies**: orders/, inventory/, customers/, billing/

**Dependents**: analytics/, admin/

---

### analytics/ (Data Analysis Module)
**Purpose**: Analyze trends and generate insights

**Exports**:
- `getSalesMetrics(period)` → Metrics
- `getInventoryTrends()` → Trends
- `getCustomerInsights()` → Insights
- `getPredictions(model)` → Predictions

**Private**:
- ML model training
- Statistical analysis

**Dependencies**: orders/, inventory/, customers/, reports/

**Dependents**: admin/, marketing/, ai/

---

### ai/ (AI Agent Platform Module)
**Purpose**: Extensible AI agent infrastructure

**Exports**:
```typescript
interface AIAgent {
  name: string;
  purpose: string;
  capabilities: string[];
  execute(request): Promise<response>;
}

interface AIProvider {
  name: string; // "openai", "claude", "ollama"
  invoke(prompt, context): Promise<response>;
}

// Registration & Discovery
registerAgent(agent: AIAgent) → void
registerProvider(provider: AIProvider) → void
executeAgent(agentName, request) → Promise<response>
listAgents() → AIAgent[]
```

**Agents**:
- PharmacyAssistant - Drug interactions, dosage
- InventoryAssistant - Stock optimization
- SupportAssistant - Customer queries
- AnalyticsAssistant - Report generation
- ExecutiveAssistant - KPI dashboards

**Private**:
- Provider integration details
- Prompt engineering
- Context management

**Dependencies**: products/, inventory/, customers/, orders/, analytics/

**Dependents**: notifications/, admin/

---

### notifications/ (Notification Service Module)
**Purpose**: Multi-channel alert and messaging

**Exports**:
- `sendNotification(recipient, message, channels)` → void
- `scheduleNotification(trigger, action)` → void
- `getNotificationHistory(userId)` → Notification[]

**Channels**: Email, SMS, In-App Push

**Private**:
- Email template engine
- SMS gateway integration

**Dependencies**: users/, orders/, prescriptions/

**Dependents**: Admin dashboard

---

### marketing/ (Marketing Module)
**Purpose**: Customer engagement and campaigns

**Exports**:
- `createCampaign(data)` → Campaign
- `segmentCustomers(criteria)` → Segment
- `trackCampaignMetrics(campaignId)` → Metrics
- `recommendProducts(customerId)` → Recommendation[]

**Private**:
- Segmentation algorithms
- ML-based recommendations

**Dependencies**: customers/, analytics/, ai/

**Dependents**: notifications/

---

### admin/ (Administration Module)
**Purpose**: System settings and controls

**Exports**:
- `getSystemSettings()` → Settings
- `updateSettings(key, value)` → void
- `getUsersReport()` → Report
- `auditLog(query)` → AuditEntry[]

**Private**:
- Audit trail persistence
- Permission matrix

**Dependencies**: users/, reports/, analytics/

**Dependents**: None

---

## Import Rules

✅ **ALLOWED**:
- auth/ → Nothing (core)
- users/ → auth/
- customers/ → auth/, users/
- products/ → pharmacy/
- inventory/ → products/, pharmacy/
- orders/ → products/, inventory/, billing/
- prescriptions/ → customers/, products/, pharmacy/
- billing/ → orders/, prescriptions/
- analytics/ → orders/, inventory/, customers/
- ai/ → Any domain module
- notifications/ → Any module (broadcast only)
- admin/ → Any module (read-only)

❌ **FORBIDDEN**:
- Circular dependencies (A → B → A)
- Presentation layer importing domain directly
- Domain modules importing presentation
- Orders importing inventory directly
- Products importing orders

---

## Module Folder Structure

```
src/
├── modules/
│   ├── auth/
│   │   ├── index.ts (exports)
│   │   ├── auth.service.ts
│   │   ├── auth.repository.ts
│   │   ├── types.ts
│   │   └── __tests__/
│   ├── users/
│   │   ├── index.ts
│   │   ├── users.service.ts
│   │   ├── users.repository.ts
│   │   ├── types.ts
│   │   └── __tests__/
│   └── [other modules...]
├── services/
│   ├── notification.service.ts
│   ├── ai.service.ts
│   └── event.service.ts
├── routes/
│   ├── auth.tsx
│   ├── dashboard.tsx
│   └── [pages...]
└── shared/
    ├── utils/
    ├── constants/
    └── types/
```

---

**Version**: 4.0 | **Status**: ACTIVE | **Last Updated**: 2026-07-20
