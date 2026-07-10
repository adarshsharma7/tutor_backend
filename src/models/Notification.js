import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: [
      'course_enrolled',      // Jab koi course enroll kare
      'lesson_completed',     // Jab lesson complete ho
      'course_completed',     // Jab pura course complete ho
      'new_lesson',          // Jab enrolled course me naya lesson aaye
      'course_updated',      // Jab enrolled course update ho
      'announcement',        // Tutor ki taraf se announcement
      'reminder',           // Course continue karne ki reminder
      'certificate',        // Certificate ready ho gaya
      'tutor_reply',        // Tutor ne comment/question ka reply diya
      'review_reply',
      'new_review',
      'direct_message',
      'study_plan_generated',
      'assignment_created',
      'assignment_graded',
      'fee_paid',
      'subscription_upgraded',
      'subscription_expired',
      'exam_reevaluation_approved',
      'exam_reevaluation_rejected'
    ],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  data: {
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course'
    },
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lesson'
    },
    // Extra data jo notification me use ho sakta hai
    extras: mongoose.Schema.Types.Mixed
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 2592000 // 30 days me auto-delete (optional)
  }
});

// Index for faster queries
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export default mongoose.model('Notification', notificationSchema);
