import Tutor from '../models/Tutor.js';
import User from '../models/User.js';
import Category from '../models/Category.js';

// @desc    Get all tutors with filters
// @route   GET /api/tutors
export const getAllTutors = async (req, res) => {
  try {
    const { categoryId, minRating, maxRate, search, scope } = req.query;

    // Build filter object - Only show approved/verified tutors to students
    let filter = { isVerified: true };

  // ✅ FIX: In MongoDB, missing fields and 'null' values need to be checked together
    const globalInstituteFilter = { $in: [null, undefined] };

    // Multi-tenancy Scope Logic (Global vs Institute)
    if (scope === 'global') {
      // Global tutors are those who are not affiliated with any institute (null or missing)
      filter.instituteId = globalInstituteFilter;
    } else if (scope === 'institute' && req.user) {
      // Institute tutors are those affiliated with the user's institute
      const user = await User.findById(req.user.id);
      if (user && user.instituteId) {
        filter.instituteId = user.instituteId;
      } else {
        return res.status(400).json({
          success: false,
          message: 'You are not enrolled in any institute.',
          tutors: []
        });
      }
    } else if (!req.user || req.user.role === 'student') {
      // Default student/guest view: see global tutors OR their own institute tutors
      if (req.user) {
        const user = await User.findById(req.user.id);
        if (user && user.instituteId) {
          filter.$or = [
            { instituteId: globalInstituteFilter },
            { instituteId: user.instituteId }
          ];
        } else {
          filter.instituteId = globalInstituteFilter;
        }
      } else {
        filter.instituteId = globalInstituteFilter;
      }
    }

    if (categoryId) {
      filter.categoryId = categoryId;
    }

    if (minRating) {
      filter.rating = { $gte: parseFloat(minRating) };
    }

    if (maxRate) {
      filter.hourlyRate = { $lte: parseFloat(maxRate) };
    }

    // If an authenticated student is making this request, exclude tutors who blocked them
    if (req.user && req.user.role === 'student') {
      filter.blockedStudents = { $ne: req.user._id };
    }
    const tutors = await Tutor.find(filter)
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon')
      .populate('instituteId', 'name')
      .sort({ rating: -1, studentsCount: -1 });

    // Search by name if provided
    let filteredTutors = tutors;
    if (search) {
      filteredTutors = tutors.filter(tutor =>
        tutor.userId && tutor.userId.name && tutor.userId.name.toLowerCase().includes(search.toLowerCase())
      );
    }

    res.status(200).json({
      success: true,
      count: filteredTutors.length,
      tutors: filteredTutors
    });
  } catch (error) {
    console.error('Get tutors error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get single tutor by ID
// @route   GET /api/tutors/:id
export const getTutorById = async (req, res) => {
  try {
    const { id } = req.params;
    const tutor = await Tutor.findById(id)
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon description')
      .populate('instituteId', 'name');

    if (!tutor) {
      return res.status(404).json({
        success: false,
        message: 'Tutor not found'
      });
    }

    // DB-level check: If authenticated student is blocked by this tutor, deny access
    if (req.user && req.user.role === 'student') {
      const isBlocked = tutor.blockedStudents?.some(
        bId => bId.toString() === req.user._id.toString()
      );
      if (isBlocked) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to view this tutor'
        });
      }
    }

    res.status(200).json({
      success: true,
      tutor
    });
  } catch (error) {
    console.error('Get tutor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get tutors by category
// @route   GET /api/tutors/category/:categoryId
export const getTutorsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }
    const tutors = await Tutor.find({ categoryId, isVerified: true })
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon')
      .populate('instituteId', 'name')
      .sort({ rating: -1 });

    res.status(200).json({
      success: true,
      category: category.name,
      count: tutors.length,
      tutors
    });
  } catch (error) {
    console.error('Get tutors by category error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Create tutor profile
// @route   POST /api/tutors
export const createTutor = async (req, res) => {
  try {
    const {
      categoryId,
      hourlyRate,
      experience,
      subjects,
      availability,
      bio
    } = req.body;

    if (!categoryId || !hourlyRate || !experience) {
      return res.status(400).json({
        success: false,
        message: 'Category, hourly rate, and experience are required'
      });
    }

    // Check if user already has a tutor profile
    const existingTutor = await Tutor.findOne({ userId: req.user.id });
    if (existingTutor) {
      return res.status(400).json({
        success: false,
        message: 'Tutor profile already exists'
      });
    }

    // Check if category exists
    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Get institute from user context
    const user = await User.findById(req.user.id);
    const instituteId = user?.instituteId || null;

    const tutor = await Tutor.create({
      userId: req.user.id,
      categoryId,
      hourlyRate,
      experience,
      subjects: subjects || [],
      availability: availability || [],
      bio: bio || '',
      title: req.body.title || '',
      website: req.body.website || '',
      location: req.body.location || '',
      instituteId
    });

    // Update user role to tutor
    await User.findByIdAndUpdate(req.user.id, { role: 'tutor' });

    // Update category tutor count
    category.tutorCount += 1;
    await category.save();

    const populatedTutor = await Tutor.findById(tutor._id)
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon');

    res.status(201).json({
      success: true,
      message: 'Tutor profile created successfully',
      tutor: populatedTutor
    });
  } catch (error) {
    console.error('Create tutor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Update tutor profile
// @route   PATCH /api/tutors/:id
export const updateTutor = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      categoryId,
      hourlyRate,
      experience,
      subjects,
      availability,
      bio
    } = req.body;

    const tutor = await Tutor.findById(id);

    if (!tutor) {
      return res.status(404).json({
        success: false,
        message: 'Tutor not found'
      });
    }

    // Check if user owns this tutor profile
    if (tutor.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this profile'
      });
    }

    if (categoryId !== undefined) tutor.categoryId = categoryId;
    if (hourlyRate !== undefined) tutor.hourlyRate = hourlyRate;
    if (experience !== undefined) tutor.experience = experience;
    if (subjects !== undefined) tutor.subjects = subjects;
    if (availability !== undefined) tutor.availability = availability;
    if (bio !== undefined) tutor.bio = bio;
    if (req.body.title !== undefined) tutor.title = req.body.title;
    if (req.body.website !== undefined) tutor.website = req.body.website;
    if (req.body.location !== undefined) tutor.location = req.body.location;

    if (req.body.notificationPreferences !== undefined) {
      const nextPrefs = req.body.notificationPreferences || {};
      tutor.notificationPreferences = {
        enrollment: nextPrefs.enrollment !== undefined ? Boolean(nextPrefs.enrollment) : Boolean(tutor.notificationPreferences?.enrollment),
        reviews: nextPrefs.reviews !== undefined ? Boolean(nextPrefs.reviews) : Boolean(tutor.notificationPreferences?.reviews),
        summary: nextPrefs.summary !== undefined ? Boolean(nextPrefs.summary) : Boolean(tutor.notificationPreferences?.summary),
        promotions: nextPrefs.promotions !== undefined ? Boolean(nextPrefs.promotions) : Boolean(tutor.notificationPreferences?.promotions),
      };
    }

    await tutor.save();

    const updatedTutor = await Tutor.findById(id)
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon');

    res.status(200).json({
      success: true,
      message: 'Tutor profile updated successfully',
      tutor: updatedTutor
    });
  } catch (error) {
    console.error('Update tutor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Delete tutor profile
// @route   DELETE /api/tutors/:id
export const deleteTutor = async (req, res) => {
  try {
    const { id } = req.params;

    const tutor = await Tutor.findById(id);

    if (!tutor) {
      return res.status(404).json({
        success: false,
        message: 'Tutor not found'
      });
    }

    // Check if user owns this tutor profile
    if (tutor.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this profile'
      });
    }

    // Update category tutor count
    const category = await Category.findById(tutor.categoryId);
    if (category) {
      category.tutorCount = Math.max(0, category.tutorCount - 1);
      await category.save();
    }

    await tutor.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Tutor profile deleted successfully'
    });
  } catch (error) {
    console.error('Delete tutor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get current logged in tutor profile
// @route   GET /api/tutors/profile
export const getCurrentTutor = async (req, res) => {
  try {
    let tutor = await Tutor.findOne({ userId: req.user.id })
      .populate('userId', 'name email phone profileImage')
      .populate('categoryId', 'name icon');

    if (!tutor) {
      if (req.user.role === 'tutor') {
        tutor = await Tutor.create({ userId: req.user.id });
        tutor = await Tutor.findById(tutor._id)
          .populate('userId', 'name email phone profileImage')
          .populate('categoryId', 'name icon');
      } else {
        return res.status(404).json({
          success: false,
          message: 'Tutor profile not found'
        });
      }
    }

    // Get course count
    // Dynamic import to avoid circular dependency if Course imports Tutor
    const Course = (await import('../models/Course.js')).default;
    const courseCount = await Course.countDocuments({ tutorId: tutor._id });

    // Get real students count (unique learners)
    const Enrollment = (await import('../models/Enrollment.js')).default;
    const courseIds = await Course.find({ tutorId: tutor._id }).distinct('_id');
    const uniqueStudents = await Enrollment.distinct('studentId', { courseId: { $in: courseIds }, status: 'active' });
    const studentsCount = uniqueStudents.length;

    // Return tutor object converted to object + courseCount + studentsCount
    const tutorObj = tutor.toObject();
    tutorObj.courseCount = courseCount;
    tutorObj.studentsCount = studentsCount;

    res.status(200).json({
      success: true,
      tutor: tutorObj
    });
  } catch (error) {
    console.error('Get current tutor error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// @desc    Get all announcements for current tutor across courses and batches
// @route   GET /api/tutors/announcements
export const getTutorAnnouncements = async (req, res) => {
  try {
    const tutor = await Tutor.findOne({ userId: req.user.id });
    if (!tutor) {
      return res.status(404).json({ success: false, message: 'Tutor profile not found' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const type = req.query.type;

    const Course = (await import('../models/Course.js')).default;
    const Batch = (await import('../models/Batch.js')).default;

    const [courses, batches] = await Promise.all([
      Course.find({ tutorId: tutor._id }).select('title announcements'),
      Batch.find({ tutorId: tutor._id }).select('name courseId announcements').populate('courseId', 'title'),
    ]);

    const courseAnnouncements = [];
    courses.forEach((course) => {
      (course.announcements || []).forEach((announcement) => {
        courseAnnouncements.push({
          sourceType: 'course',
          sourceId: course._id,
          sourceTitle: course.title,
          title: announcement.title,
          message: announcement.message,
          createdAt: announcement.createdAt || course.updatedAt || course.createdAt,
        });
      });
    });

    const batchAnnouncements = [];
    batches.forEach((batch) => {
      (batch.announcements || []).forEach((announcement) => {
        batchAnnouncements.push({
          sourceType: 'batch',
          sourceId: batch._id,
          sourceTitle: batch.name,
          courseTitle: batch.courseId?.title || '',
          title: announcement.title,
          message: announcement.message,
          createdAt: announcement.createdAt || batch.updatedAt || batch.createdAt,
        });
      });
    });

    const allAnnouncements = [...courseAnnouncements, ...batchAnnouncements]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const filteredAnnouncements = (type === 'course' || type === 'batch')
      ? allAnnouncements.filter((item) => item.sourceType === type)
      : allAnnouncements;

    return res.status(200).json({
      success: true,
      stats: {
        total: allAnnouncements.length,
        course: courseAnnouncements.length,
        batch: batchAnnouncements.length,
      },
      announcements: filteredAnnouncements.slice(0, limit),
    });
  } catch (error) {
    console.error('Get tutor announcements error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @desc    Get tutor stats (dashboard)
// @route   GET /api/tutors/stats
// @desc    Get tutor stats (dashboard)
// @route   GET /api/tutors/stats
export const getTutorStats = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get Tutor Profile (Added populate to get real name for the UI greeting)
    let tutor = await Tutor.findOne({ userId }).populate('userId', 'name profileImage');
    
    if (!tutor) {
      if (req.user.role === 'tutor') {
        tutor = await Tutor.create({ userId });
        tutor = await Tutor.findById(tutor._id).populate('userId', 'name profileImage');
      } else {
        return res.status(404).json({ success: false, message: 'Tutor profile not found' });
      }
    }

    // 2. Get Courses
    const Course = (await import('../models/Course.js')).default;
    const courses = await Course.find({ tutorId: tutor._id });
    const courseIds = courses.map(c => c._id);

    const activeCourses = courses.filter(c => c.status === 'published').length;
    const totalCourses = courses.length;

    // 3. Get Enrollments (Total Students & Earnings)
    const Enrollment = (await import('../models/Enrollment.js')).default;
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } })
      .populate('studentId', 'name email profileImage')
      .populate('courseId', 'title price thumbnail')
      .sort({ enrolledAt: -1 });

    const totalEarnings = enrollments.reduce((sum, enrollment) => {
      return sum + (enrollment.courseId?.price || 0);
    }, 0);

    const uniqueStudents = new Set(enrollments.map(e => e.studentId?._id.toString())).size;

    // 4. Calculate Ratings & Distribution
    const totalRatings = courses.reduce((sum, course) => sum + (course.rating || 0), 0);
    const avgRating = totalCourses > 0 ? (totalRatings / totalCourses).toFixed(1) : 0;

    const Review = (await import('../models/Review.js')).default;
    const reviews = await Review.find({ courseId: { $in: courseIds } });

    const ratingsDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(review => {
      const rating = Math.round(review.rating);
      if (ratingsDistribution[rating] !== undefined) ratingsDistribution[rating]++;
    });

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    const isCurrentMonth = (date) => new Date(date).getMonth() === currentMonth && new Date(date).getFullYear() === currentYear;
    const isLastMonth = (date) => new Date(date).getMonth() === lastMonth && new Date(date).getFullYear() === lastMonthYear;

    // --- Trend Calculations ---
    const currentMonthStudents = new Set(enrollments.filter(e => isCurrentMonth(e.enrolledAt)).map(e => e.studentId?._id.toString()));
    const lastMonthStudents = new Set(enrollments.filter(e => isLastMonth(e.enrolledAt)).map(e => e.studentId?._id.toString()));

    const calculateTrend = (current, previous) => {
      if (previous === 0) return current === 0 ? 0 : null;
      return ((current - previous) / previous) * 100;
    };

    const studentTrend = calculateTrend(currentMonthStudents.size, lastMonthStudents.size);
    const currentMonthEarnings = enrollments.filter(e => isCurrentMonth(e.enrolledAt)).reduce((sum, e) => sum + (e.courseId?.price || 0), 0);
    const lastMonthEarnings = enrollments.filter(e => isLastMonth(e.enrolledAt)).reduce((sum, e) => sum + (e.courseId?.price || 0), 0);
    const earningsTrend = calculateTrend(currentMonthEarnings, lastMonthEarnings);

    const currentMonthCourses = courses.filter(c => c.status === 'published' && isCurrentMonth(c.createdAt)).length;
    const lastMonthCourses = courses.filter(c => c.status === 'published' && isLastMonth(c.createdAt)).length;
    const coursesTrend = calculateTrend(currentMonthCourses, lastMonthCourses);

    const currentMonthReviews = reviews.filter(r => isCurrentMonth(r.createdAt));
    const lastMonthReviews = reviews.filter(r => isLastMonth(r.createdAt));
    const reviewsTrend = calculateTrend(currentMonthReviews.length, lastMonthReviews.length);

    // 5. Recent Enrollments
    const recentEnrollments = enrollments.slice(0, 5).map(e => ({
      _id: e._id,
      studentName: e.studentId?.name || 'Unknown',
      studentImage: e.studentId?.profileImage,
      studentId: e.studentId?._id,
      courseTitle: e.courseId?.title || 'Unknown Course',
      price: e.courseId?.price || 0,
      enrolledAt: e.enrolledAt
    }));

    // 6. Top Courses
    const topCourses = courses
      .sort((a, b) => b.enrolledCount - a.enrolledCount)
      .slice(0, 5)
      .map(c => ({
        id: c._id,
        name: c.title,
        count: c.enrolledCount.toLocaleString(),
        trend: (c.rating || 0).toFixed(1),
        trendUp: true,
        bg: 'bg-blue-100',
        color: 'text-blue-600'
      }));

    // 7. Monthly Data
    const monthlyData = Array.from({ length: 12 }, (_, i) => {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      return {
        name: d.toLocaleString('default', { month: 'short' }),
        students: 0,
        enrollments: 0
      };
    }).reverse();

    enrollments.forEach(e => {
      const monthName = new Date(e.enrolledAt).toLocaleString('default', { month: 'short' });
      const monthParams = monthlyData.find(m => m.name === monthName);
      if (monthParams) {
        monthParams.enrollments += 1;
        monthParams.students += 1;
      }
    });

    // 8b. Weekly Performance (Perfectly matched for the Area Chart)
    const Progress = (await import('../models/Progress.js')).default;
    const weeklyPerformance = await Promise.all(
      [0, 1, 2, 3].map(async (weekIndex) => {
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - (28 - weekIndex * 7));
        const weekEnd = new Date();
        weekEnd.setDate(weekEnd.getDate() - (21 - weekIndex * 7));

        const [weekEnrollments, weekCompletions, weekRevenue] = await Promise.all([
          Enrollment.countDocuments({ courseId: { $in: courseIds }, enrolledAt: { $gte: weekStart, $lt: weekEnd } }),
          Progress.countDocuments({ courseId: { $in: courseIds }, completed: true, completedAt: { $gte: weekStart, $lt: weekEnd } }),
          Enrollment.find({ courseId: { $in: courseIds }, enrolledAt: { $gte: weekStart, $lt: weekEnd } })
            .populate('courseId', 'price')
            .then(enrs => enrs.reduce((sum, e) => sum + (e.courseId?.price || 0), 0)),
        ]);

        return {
          name: `Week ${weekIndex + 1}`,
          enrollments: weekEnrollments,
          completions: weekCompletions,
          revenue: weekRevenue,
        };
      })
    );

    // 8c. Recent Student Activity (Mapped exact UI fields)
    const recentStudentActivity = await Promise.all(
      enrollments.slice(0, 5).map(async (enr) => {
        if (!enr.studentId || !enr.courseId) return null;

        const course = courses.find(c => c._id.toString() === (enr.courseId._id || enr.courseId).toString());
        const totalLessons = await (await import('../models/Lesson.js')).default.countDocuments({ courseId: enr.courseId._id || enr.courseId });
        const completedLessons = await Progress.countDocuments({ studentId: enr.studentId._id, courseId: enr.courseId._id || enr.courseId, completed: true });

        const lastProgress = await Progress.findOne({ studentId: enr.studentId._id, courseId: enr.courseId._id || enr.courseId }).sort({ createdAt: -1 });

        // Safe percentage calculation
        const score = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

        const lastActivityDate = lastProgress?.createdAt || enr.enrolledAt;
        const diffMins = Math.floor((now - new Date(lastActivityDate)) / 60000);
        
        let lastActivityStr = 'Just now';
        if (diffMins > 0) {
            if (diffMins < 60) lastActivityStr = `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
            else if (diffMins < 1440) lastActivityStr = `${Math.floor(diffMins / 60)} hr${Math.floor(diffMins / 60) !== 1 ? 's' : ''} ago`;
            else lastActivityStr = `${Math.floor(diffMins / 1440)} day${Math.floor(diffMins / 1440) !== 1 ? 's' : ''} ago`;
        }

        return {
          studentName: enr.studentId?.name || 'Unknown',
          studentImage: enr.studentId?.profileImage || null,
          courseName: enr.courseId?.title || course?.title || 'Unknown',
          score: score,
          lastActivity: lastActivityStr,
        };
      })
    ).then(results => results.filter(Boolean));

    // 8. Action queue + communications snapshot
    const LiveClass = (await import('../models/LiveClass.js')).default;
    const Assignment = (await import('../models/Assignment.js')).default;
    const Submission = (await import('../models/Submission.js')).default;
    const Batch = (await import('../models/Batch.js')).default;
    const Notification = (await import('../models/Notification.js')).default;

    const upcomingClassesCount = await LiveClass.countDocuments({
      tutorId: tutor._id,
      dateTime: { $gte: now },
      status: { $in: ['scheduled', 'live'] },
    });

    const assignmentIds = (await Assignment.find({ courseId: { $in: courseIds } }).select('_id').lean()).map(a => a._id);
    const pendingAssignmentReviews = assignmentIds.length > 0
      ? await Submission.countDocuments({ assignmentId: { $in: assignmentIds }, status: 'submitted' })
      : 0;

    const unreadNotificationsCount = await Notification.countDocuments({ userId, isRead: false });

    const batches = await Batch.find({ tutorId: tutor._id }).select('name announcements courseId').populate('courseId', 'title').lean();

    const recentAnnouncements = [
      ...courses.flatMap(c => (c.announcements || []).map(a => ({ title: a.title, message: a.message, createdAt: a.createdAt }))),
      ...batches.flatMap(b => (b.announcements || []).map(a => ({ title: a.title, message: a.message, createdAt: a.createdAt }))),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4); // Max 4 for UI

    // Return all matched data to Frontend
    res.status(200).json({
      success: true,
      stats: {
        tutorName: tutor.userId?.name || 'Tutor', // Used for greeting
        totalStudents: uniqueStudents,
        activeCourses,
        totalEarnings,
        avgRating,
        recentEnrollments,
        topCourses,
        monthlyData,
        weeklyPerformance, // Chart data
        recentStudentActivity, // Table data
        upcomingClassesCount,
        pendingAssignmentReviews,
        unreadNotificationsCount,
        recentAnnouncements, // Notification box
        ratingsDistribution,
        totalReviews: reviews.length,
        trends: { students: studentTrend, courses: coursesTrend, earnings: earningsTrend, reviews: reviewsTrend },
        isVerified: tutor.isVerified
      }
    });

  } catch (error) {
    console.error('Get tutor stats error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @desc    Get student details for tutor (specific to tutor's courses)
// @route   GET /api/tutors/students/:id
export const getTutorStudentDetails = async (req, res) => {
  try {
    const { id } = req.params; // Student ID
    const userId = req.user.id; // Tutor ID (User ID)

    const tutor = await Tutor.findOne({ userId });
    if (!tutor) return res.status(404).json({ success: false, message: 'Tutor profile not found' });

    const student = await User.findById(id).select('name email phone profileImage bio address joinedAt createdAt');
    if (!student) return res.status(404).json({ success: false, message: 'Student not found' });

    // Find courses created by this tutor
    // Dynamic import to avoid circular dependency if needed, but imported at top? No, dynamic used in other functions.
    // Let's use dynamic for consistency if imports are issues throughout file.
    const Course = (await import('../models/Course.js')).default;
    const courses = await Course.find({ tutorId: tutor._id });
    const courseIds = courses.map(c => c._id);

    // Find enrollments of this student in these courses
    const Enrollment = (await import('../models/Enrollment.js')).default;
    const enrollments = await Enrollment.find({
      studentId: id,
      courseId: { $in: courseIds }
    }).populate('courseId', 'title price thumbnail level category status')
      .sort({ enrolledAt: -1 });

    const totalSpent = enrollments.reduce((sum, enr) => sum + (enr.courseId?.price || 0), 0);

    res.status(200).json({
      success: true,
      student,
      enrollments,
      totalSpent,
      tutorCoursesCount: enrollments.length
    });

  } catch (error) {
    console.error('Get tutor student details error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// @desc    Get all students enrolled in a tutor's courses
// @route   GET /api/tutors/students
export const getAllTutorStudents = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get Tutor Profile
    const tutor = await Tutor.findOne({ userId });
    if (!tutor) return res.status(404).json({ success: false, message: 'Tutor profile not found' });

    // 2. Get Courses taught by tutor
    const Course = (await import('../models/Course.js')).default;
    const courses = await Course.find({ tutorId: tutor._id });
    const courseIds = courses.map(c => c._id);

    // 3. Get unique students from Enrollments
    const Enrollment = (await import('../models/Enrollment.js')).default;
    const enrollments = await Enrollment.find({ courseId: { $in: courseIds } })
      .populate('studentId', 'name email profileImage');

    // Deduplicate students
    const uniqueStudentsMap = new Map();
    enrollments.forEach(enr => {
      if (enr.studentId && !uniqueStudentsMap.has(enr.studentId._id.toString())) {
        uniqueStudentsMap.set(enr.studentId._id.toString(), enr.studentId);
      }
    });

    const studentList = Array.from(uniqueStudentsMap.values());

    res.status(200).json({
      success: true,
      data: studentList
    });
  } catch (error) {
    console.error('Get all tutor students error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};
