Architectural Blueprint: South African Hospitality SaaS Platform

1. Executive Summary

This document outlines the architectural design and system functionality for a B2B SaaS platform tailored to the South African hospitality market, functioning similarly to 7shifts. The primary objective is to automate rotational waiter scheduling, time clocking, payroll, tip management, and digital handovers while strictly adhering to local labor laws (BCEA), tax regulations (SARS), and data protection standards (POPIA).

The system relies on a multi-tenant PostgreSQL database architecture, ensuring that franchise locations are securely isolated using Row-Level Security (RLS).

2. Phase 1: Schedule (Scheduling, Time Clocking, & Labor Compliance)

This module handles dynamic rotational scheduling, captures precise time-clocking data, and automates compliance with the Basic Conditions of Employment Act (BCEA).

Database Schema

employees table: Manages staff profiles, tenant linkage, role assignments, hourly rates, and standard weekly hours (default 45).

shifts table: Stores the planned rotational roster (tenant_id, employee_id, planned_start, planned_end, rotational flag, and status).

time_entries table: Tracks the exact execution of shifts (tenant_id, shift_id, clock_in, clock_out, total_logged_hours) for automated payroll ingestion.

System Functionality & Logic

Rotational Logic: Supports recurring scheduling blocks for waitstaff.

BCEA Compliance Engine:

Daily Rest Period Check: Validates a minimum 12-hour rest gap between shifts.

Maximum Hours Flag: Alerts management if scheduled hours exceed the 45-hour weekly threshold, triggering overtime rates.

Security: Implements PostgreSQL Row-Level Security (tenant_id = auth.uid()) to prevent cross-restaurant data leakage.

3. Phase 2: Pay (Payroll & Tip Management)

This module acts as an automated calculation engine, pulling hours from the time-clocking module to generate legally compliant payroll and tip distribution records.

Database Schema

pay_periods table: Defines the financial cycle (weekly, bi-weekly, monthly) for each restaurant.

payroll_records table: The immutable ledger calculating gross basic pay, overtime, UIF deductions (1%), PAYE deductions, and net pay per employee.

tip_pools table: Configures front-of-house (FOH) and back-of-house (BOH) tip distribution percentages.

shift_tips table: Logs declared cash, credit card tips, and service charges per shift.

tip_distributions table: Stores the finalized tip allocation per employee per shift.

System Functionality & Logic

Minimum Wage Enforcement: Ensures the base calculation meets the National Minimum Wage (R30.23/hr).

UIF Cap Logic: Automatically caps UIF calculations at the SARS remuneration threshold (R17,712/month).

ETI Flags: Identifies staff eligible for the Employment Tax Incentive based on age and minimum wage compliance.

Taxation on Tips: Flags employer-routed tips (e.g., credit card tips) to be included in PAYE taxation calculations.

4. Phase 3: Retain (Manager Log Book)

A secure, digital handover and performance tracking tool designed to replace physical logbooks and create a legally sound audit trail for CCMA disputes.

Database Schema

manager_logs table: The primary ledger for handovers, maintenance, and disciplinary notes.

log_acknowledgements table: Tracks timestamps of when incoming managers read required handover notes.

performance_tracking table: Structured audit trails linking specific infractions (e.g., late arrivals) to employee profiles.

System Functionality & Logic

Immutability for CCMA: Utilizes an append-only architecture. Edited logs create new revision rows rather than overwriting existing data, ensuring legal integrity.

Role-Based Access Control (RBAC): Cryptographically restricts read/write access to shift_manager, general_manager, and owner roles to comply with POPIA.

5. Outstanding Architectural Tasks (To Be Completed)

The database, multi-tenancy rules, and business logic are roughly 70% complete. The following infrastructure and middleware components must be designed and documented before development begins:

[ ] Task 1: Authentication & Identity Access Management (IAM)

Design the JWT issuance and validation flow.

Map out secure credential storage and session management.

Finalize the RBAC enforcement logic at the API edge.

[ ] Task 2: API & Middleware Architecture

Determine the backend framework (e.g., Node.js/Express, Python/FastAPI).

Design the API communication protocol (RESTful vs. GraphQL).

Implement input validation schemas (e.g., Zod) and Object-Relational Mapping (ORM) structures (e.g., Prisma or Drizzle).

[ ] Task 3: Real-Time & Notification Engine

Architect WebSockets or Server-Sent Events (SSE) for real-time manager log alerts.

Design queue-based background workers (e.g., Redis/BullMQ) for sending SMS/email schedule reminders to staff.

[ ] Task 4: Cloud Infrastructure & CI/CD

Map out the hosting environment (e.g., AWS, Azure, Vercel).

Design the database scaling strategy, backup procedures, and disaster recovery plan.

Outline the Continuous Integration/Continuous Deployment (CI/CD) pipeline for safe staging and production rollouts.

[ ] Task 5: Third-Party Integrations Structure

Design API export payloads compatible with local accounting software (Xero, Sage).

Define the .csv or API structure required for SARS EMP201 monthly submissions.